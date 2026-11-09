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

use std::path::{Path, PathBuf};
use std::sync::RwLock;

#[derive(Debug, Default)]
struct State {
    account: Option<String>,
    anon: String,
    dir: Option<PathBuf>,
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

    pub fn account(&self) -> Option<String> {
        self.read(|s| s.account.clone())
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
            let anon = uuid::Uuid::new_v4().to_string();
            if let Some(dir) = &s.dir {
                let path = anon_path(dir);
                if let Some(parent) = path.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                if let Err(e) = std::fs::write(&path, &anon) {
                    tracing::warn!(error = %e, "couldn't keep the new anonymous id");
                }
            }
            s.anon = anon;
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
    fn the_install_id_stands_in_until_a_sign_out() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(stored_anon_id(dir.path(), "install"), "install");
        std::fs::create_dir_all(dir.path().join("telemetry")).unwrap();
        std::fs::write(anon_path(dir.path()), "me@example.com").unwrap();
        assert_eq!(stored_anon_id(dir.path(), "install"), "install");
    }
}
