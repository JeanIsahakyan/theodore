//! Who this build is (docs/releasing.md "One identity per build"): every
//! name a build could share with another build installed beside it, derived
//! from its build environment so a staging, nightly or dev build never
//! reads or writes production's data.
//!
//! | | production | staging | nightly | dev |
//! | --- | --- | --- | --- | --- |
//! | product name | Theodore | Theodore Staging | Theodore Nightly | Theodore Dev |
//! | bundle id | `app.theodore.desktop` | `….staging` | `….nightly` | `….dev` |
//! | data dir | `~/.theodore` | `~/.theodore-staging` | `~/.theodore-nightly` | `~/.theodore-dev` |
//! | keychain service | `app.theodore.secrets` | `….staging` | `….nightly` | `….dev` |
//! | URL scheme | `theodore` | `theodore-staging` | `theodore-nightly` | none |
//!
//! The bundle names (product name, id, scheme) are also in the bundle
//! config: `tauri.conf.json` for production, `tauri.<env>.conf.json`
//! merged in at build time for staging and nightly; the desktop crate's
//! tests hold the two in step. A dev build is never bundled for real: it
//! runs bare (`cargo tauri dev`) and signs in through the loopback.

use std::path::{Path, PathBuf};

/// `THEODORE_BUILD_ENV`, as baked into the desktop binary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum BuildEnv {
    Production,
    Staging,
    Nightly,
    Dev,
}

impl BuildEnv {
    pub const ALL: [BuildEnv; 4] = [Self::Production, Self::Staging, Self::Nightly, Self::Dev];

    /// One of the build stamp's names (`production`, `staging`, `nightly`,
    /// `dev`); anything else is `None`.
    pub fn parse(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|e| e.as_str() == name)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Production => "production",
            Self::Staging => "staging",
            Self::Nightly => "nightly",
            Self::Dev => "dev",
        }
    }

    /// What every name of a non-production build carries; production's
    /// names are the plain ones.
    fn suffix(self) -> Option<&'static str> {
        (self != Self::Production).then(|| self.as_str())
    }
}

const PRODUCT_NAME: &str = "Theodore";
const BUNDLE_IDENTIFIER: &str = "app.theodore.desktop";
const DATA_DIR: &str = ".theodore";
const URL_SCHEME: &str = "theodore";
/// The account sign-in redirect's path on the app's URL scheme.
const CALLBACK: &str = "callback";

/// `Theodore`, `Theodore Staging`, `Theodore Nightly`, `Theodore Dev`.
pub fn product_name(env: BuildEnv) -> String {
    match env.suffix() {
        None => PRODUCT_NAME.into(),
        Some(s) => format!("{PRODUCT_NAME} {}{}", s[..1].to_ascii_uppercase(), &s[1..]),
    }
}

/// The macOS bundle identifier: `app.theodore.desktop[.<env>]`.
pub fn bundle_identifier(env: BuildEnv) -> String {
    suffixed(BUNDLE_IDENTIFIER, '.', env)
}

/// The data dir's name under the home directory: `.theodore[-<env>]`.
pub fn data_dir_name(env: BuildEnv) -> String {
    suffixed(DATA_DIR, '-', env)
}

/// `<home>/.theodore[-<env>]`; relative to the working dir without a home.
pub fn default_data_dir(env: BuildEnv, home: Option<&Path>) -> PathBuf {
    match home {
        Some(h) => h.join(data_dir_name(env)),
        None => PathBuf::from(data_dir_name(env)),
    }
}

/// The keychain item every secret lives in: its service is
/// `app.theodore.secrets[.<env>]`, its account `vault` in every build.
pub fn keychain_service(env: BuildEnv) -> String {
    suffixed(theodore_secrets::VAULT_SERVICE, '.', env)
}

/// The URL scheme the bundle registers: `theodore[-<env>]`. `None` for
/// dev: a bare binary can't receive one.
pub fn url_scheme(env: BuildEnv) -> Option<String> {
    (env != BuildEnv::Dev).then(|| suffixed(URL_SCHEME, '-', env))
}

/// The account sign-in redirect on the app's URL scheme
/// (`theodore[-<env>]://callback`), registered on the WorkOS application.
/// `None` for dev, which keeps the loopback redirect.
pub fn app_redirect_uri(env: BuildEnv) -> Option<String> {
    url_scheme(env).map(|s| format!("{s}://{CALLBACK}"))
}

/// `base` for production, `base<sep><env>` for the others.
fn suffixed(base: &str, sep: char, env: BuildEnv) -> String {
    match env.suffix() {
        None => base.into(),
        Some(s) => format!("{base}{sep}{s}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use BuildEnv::*;

    #[test]
    fn parses_the_build_stamp_names_only() {
        for env in BuildEnv::ALL {
            assert_eq!(BuildEnv::parse(env.as_str()), Some(env));
        }
        assert_eq!(BuildEnv::parse("prod"), None);
        assert_eq!(BuildEnv::parse("Staging"), None);
    }

    #[test]
    fn production_keeps_every_name_it_has_today() {
        assert_eq!(product_name(Production), "Theodore");
        assert_eq!(bundle_identifier(Production), "app.theodore.desktop");
        assert_eq!(data_dir_name(Production), ".theodore");
        assert_eq!(keychain_service(Production), "app.theodore.secrets");
        assert_eq!(url_scheme(Production).as_deref(), Some("theodore"));
        assert_eq!(
            app_redirect_uri(Production).as_deref(),
            Some("theodore://callback")
        );
    }

    #[test]
    fn every_other_build_has_names_of_its_own() {
        let rows = [
            (
                Staging,
                "Theodore Staging",
                "app.theodore.desktop.staging",
                ".theodore-staging",
                "app.theodore.secrets.staging",
                Some("theodore-staging://callback"),
            ),
            (
                Nightly,
                "Theodore Nightly",
                "app.theodore.desktop.nightly",
                ".theodore-nightly",
                "app.theodore.secrets.nightly",
                Some("theodore-nightly://callback"),
            ),
            (
                Dev,
                "Theodore Dev",
                "app.theodore.desktop.dev",
                ".theodore-dev",
                "app.theodore.secrets.dev",
                None,
            ),
        ];
        for (env, name, id, dir, service, redirect) in rows {
            assert_eq!(product_name(env), name);
            assert_eq!(bundle_identifier(env), id);
            assert_eq!(data_dir_name(env), dir);
            assert_eq!(keychain_service(env), service);
            assert_eq!(app_redirect_uri(env).as_deref(), redirect);
        }
        assert_eq!(url_scheme(Dev), None);
    }

    #[test]
    fn no_two_builds_share_a_name() {
        let all = |f: fn(BuildEnv) -> String| {
            let v: std::collections::HashSet<_> = BuildEnv::ALL.into_iter().map(f).collect();
            v.len()
        };
        assert_eq!(all(product_name), 4);
        assert_eq!(all(bundle_identifier), 4);
        assert_eq!(all(data_dir_name), 4);
        assert_eq!(all(keychain_service), 4);
    }

    #[test]
    fn the_data_dir_sits_in_home() {
        let home = Path::new("/Users/jo");
        assert_eq!(
            default_data_dir(Staging, Some(home)),
            Path::new("/Users/jo/.theodore-staging")
        );
        assert_eq!(default_data_dir(Production, None), Path::new(".theodore"));
    }
}
