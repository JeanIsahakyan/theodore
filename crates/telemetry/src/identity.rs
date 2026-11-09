//! Who the remote sinks say a record is from (docs/telemetry.md "Who a
//! record is from").
//!
//! ```text
//! never signed in ──▶ anon id (= the install id)
//! sign-in         ──▶ account id; $identify links the anon id to it
//! sign-out        ──▶ a NEW anon id: later events aren't that person's
//! ```
//!
//! Only the remote sinks read this: the local log, and so a problem report,
//! never gets the account id. The install id isn't rotated with the anon id:
//! it stays the key repository names are hashed with.
//!
//! The consent guard is here, not in each sink: a sink can only ask for
//! [`Identity::usage_account`] or [`Identity::errors_account`], and those are
//! `None` until that choice was agreed under terms that link it to the
//! account (`Choice::links_usage`).

use std::path::{Path, PathBuf};
use std::sync::RwLock;

#[derive(Debug, Default)]
struct State {
    account: Option<String>,
    anon: String,
    dir: Option<PathBuf>,
    /// The choice behind each sink allows the account id. Off by default:
    /// not knowing means anonymous.
    link_usage: bool,
    link_errors: bool,
}

impl State {
    fn replace_anon(&mut self) {
        let anon = uuid::Uuid::new_v4().to_string();
        if let Some(dir) = &self.dir {
            let path = anon_path(dir);
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            if let Err(e) = std::fs::write(&path, &anon) {
                tracing::warn!(error = %e, "couldn't keep the new anonymous id");
            }
        }
        self.anon = anon;
    }
}

#[derive(Debug, Default)]
pub struct Identity {
    state: RwLock<State>,
}

/// An account id as the provider issues it (`user_01H…`). Anything else —
/// an email or a login passed by mistake — is refused, so it can't become
/// the id remote sinks send.
pub fn is_account_id(id: &str) -> bool {
    id.len() <= 64
        && id
            .strip_prefix("user_")
            .is_some_and(|rest| !rest.is_empty() && rest.chars().all(|c| c.is_ascii_alphanumeric()))
}

/// The anonymous id in `<data_dir>/telemetry/anon_id`, or `install_id`
/// until a sign-out has replaced it.
pub fn stored_anon_id(data_dir: &Path, install_id: &str) -> String {
    std::fs::read_to_string(anon_path(data_dir))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| uuid::Uuid::parse_str(s).is_ok())
        .unwrap_or_else(|| install_id.to_string())
}

fn anon_path(data_dir: &Path) -> PathBuf {
    data_dir.join("telemetry").join("anon_id")
}

impl Identity {
    pub fn new(anon: impl Into<String>) -> Self {
        Self {
            state: RwLock::new(State {
                anon: anon.into(),
                ..State::default()
            }),
        }
    }

    /// The anon id to start from, unless one is already set. `dir`: where a
    /// replaced one is kept across restarts.
    pub fn seed(&self, anon: &str, dir: Option<PathBuf>) {
        let mut s = self.state.write().unwrap_or_else(|p| p.into_inner());
        if s.anon.is_empty() {
            s.anon = anon.to_string();
        }
        if dir.is_some() {
            s.dir = dir;
        }
    }

    #[cfg(test)]
    fn account(&self) -> Option<String> {
        self.read(|s| s.account.clone())
    }

    /// Who usage data is from: the account, if "Share usage data" was agreed
    /// under terms that link it to one.
    pub fn usage_account(&self) -> Option<String> {
        self.read(|s| s.account.clone().filter(|_| s.link_usage))
    }

    /// Who error reports are from, by the same rule for "Send error reports".
    pub fn errors_account(&self) -> Option<String> {
        self.read(|s| s.account.clone().filter(|_| s.link_errors))
    }

    /// Which sinks may carry the account id. `Telemetry::apply` sets this
    /// from the recorded choice, before any sink starts.
    pub fn set_links(&self, usage: bool, errors: bool) {
        let mut s = self.state.write().unwrap_or_else(|p| p.into_inner());
        s.link_usage = usage;
        s.link_errors = errors;
    }

    /// Replaces the anon id with one that has sent nothing. For the moment
    /// linking starts: what the old id sent was promised to stay unlinked, so
    /// `$identify` mustn't name it.
    pub fn renew_anon(&self) {
        self.state
            .write()
            .unwrap_or_else(|p| p.into_inner())
            .replace_anon();
    }

    pub fn anon(&self) -> String {
        self.read(|s| s.anon.clone())
    }

    fn read<T>(&self, f: impl FnOnce(&State) -> T) -> T {
        f(&self.state.read().unwrap_or_else(|p| p.into_inner()))
    }

    /// Records who is signed in; `true` when that changed. Leaving an
    /// account (signing out, or into another one) replaces the anon id,
    /// which is linked to the account being left.
    pub fn set(&self, account: Option<&str>) -> bool {
        let mut s = self.state.write().unwrap_or_else(|p| p.into_inner());
        if s.account.as_deref() == account {
            return false;
        }
        if s.account.is_some() {
            s.replace_anon();
        }
        s.account = account.map(str::to_string);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_provider_shaped_ids_count_as_account_ids() {
        assert!(is_account_id("user_01E4ZCR3C56J083X43JQXF3JK5"));
        for bad in [
            "",
            "user_",
            "me@example.com",
            "octocat",
            "user_a@b.c",
            "user_with space",
            &format!("user_{}", "a".repeat(64)),
        ] {
            assert!(!is_account_id(bad), "{bad}");
        }
    }

    #[test]
    fn leaving_an_account_replaces_the_anon_id_and_keeps_it() {
        let dir = tempfile::tempdir().unwrap();
        let id = Identity::new("install");
        id.seed("ignored", Some(dir.path().to_path_buf()));
        assert_eq!(id.anon(), "install");

        assert!(id.set(Some("user_a")));
        assert_eq!(id.anon(), "install", "signing in keeps the id it links");
        assert!(!id.set(Some("user_a")), "a refresh isn't a change");

        assert!(id.set(None));
        let fresh = id.anon();
        assert_ne!(fresh, "install");
        assert_eq!(id.account(), None);
        assert_eq!(stored_anon_id(dir.path(), "install"), fresh);
        assert!(!id.set(None), "already signed out: not replaced again");
        assert_eq!(id.anon(), fresh);

        assert!(id.set(Some("user_a")));
        assert!(id.set(Some("user_b")));
        assert_ne!(id.anon(), fresh, "another account: not the same person");
    }

    #[test]
    fn the_account_is_only_handed_out_under_a_choice_that_links_it() {
        let id = Identity::new("install");
        id.set(Some("user_a"));
        assert_eq!(id.usage_account(), None, "unknown terms are the old ones");
        assert_eq!(id.errors_account(), None);

        id.set_links(true, false);
        assert_eq!(id.usage_account().as_deref(), Some("user_a"));
        assert_eq!(id.errors_account(), None, "each choice is its own");

        id.set_links(false, true);
        assert_eq!(id.usage_account(), None);
        assert_eq!(id.errors_account().as_deref(), Some("user_a"));

        id.set(None);
        assert_eq!(id.errors_account(), None, "signed out: nobody to name");
    }

    #[test]
    fn renewing_the_anon_id_leaves_the_install_id_behind_for_good() {
        let dir = tempfile::tempdir().unwrap();
        let id = Identity::new("install");
        id.seed("ignored", Some(dir.path().to_path_buf()));
        id.renew_anon();
        let fresh = id.anon();
        assert_ne!(fresh, "install");
        assert_eq!(stored_anon_id(dir.path(), "install"), fresh);
    }

    #[test]
    fn the_install_id_stands_in_until_a_sign_out() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(stored_anon_id(dir.path(), "install"), "install");
        std::fs::create_dir_all(dir.path().join("telemetry")).unwrap();
        std::fs::write(anon_path(dir.path()), "me@example.com").unwrap();
        assert_eq!(stored_anon_id(dir.path(), "install"), "install");
    }
}
