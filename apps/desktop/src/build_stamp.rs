//! The pure half of the build stamp: `build.rs` includes this file (by
//! `#[path]`) to turn its inputs into the baked values, and `build_info`
//! uses it to print them. No `env!` here — the build script has none.

/// The build environments a binary can carry, in `THEODORE_BUILD_ENV`.
pub const BUILD_ENVS: [&str; 4] = ["production", "staging", "nightly", "dev"];

/// `THEODORE_BUILD_ENV` → one of `BUILD_ENVS`. Unset or blank is `dev`
/// (a local cargo/tauri build); `prod` is accepted for `production`.
/// Anything else is an error, so a typo fails the build instead of
/// shipping as `dev`.
pub fn build_env(raw: Option<&str>) -> Result<&'static str, String> {
    let v = raw.unwrap_or("").trim().to_ascii_lowercase();
    match v.as_str() {
        "" => Ok("dev"),
        "prod" => Ok("production"),
        _ => BUILD_ENVS.iter().copied().find(|e| *e == v).ok_or_else(|| {
            format!(
                "THEODORE_BUILD_ENV={v:?}: expected one of {}",
                BUILD_ENVS.join(", ")
            )
        }),
    }
}

/// The commit to bake: `sha` (trimmed, lowercased), `unknown` without one,
/// and `-dirty` when a dev build was made from uncommitted changes. Other
/// environments are built from a commit as is, so they never say dirty.
pub fn commit(sha: Option<&str>, dirty: bool, env: &str) -> String {
    let sha = sha.map(str::trim).filter(|s| !s.is_empty());
    let Some(sha) = sha else {
        return "unknown".into();
    };
    let sha = sha.to_ascii_lowercase();
    if dirty && env == "dev" {
        format!("{sha}-dirty")
    } else {
        sha
    }
}

/// What CI bakes into a release (`.github/workflows/build.yml`): without
/// these a binary has no sign-in and no diagnostics, so it isn't the build
/// it says it is. `production` and `staging` need them all; a nightly (built
/// by hand, `scripts/nightly-build.sh`) needs the account only.
pub const RELEASE_KEYS: [&str; 4] = [
    "THEODORE_WORKOS_CLIENT_ID",
    "THEODORE_OTLP_ENDPOINT",
    "THEODORE_OTLP_HEADERS",
    "THEODORE_POSTHOG_KEY",
];

/// The release keys `env` needs that `lookup` doesn't have (unset or blank).
pub fn missing_keys(env: &str, lookup: impl Fn(&str) -> Option<String>) -> Vec<&'static str> {
    let needed: &[&'static str] = match env {
        "production" | "staging" => &RELEASE_KEYS,
        "nightly" => &RELEASE_KEYS[..1],
        _ => &[],
    };
    needed
        .iter()
        .copied()
        .filter(|k| lookup(k).is_none_or(|v| v.trim().is_empty()))
        .collect()
}

/// The build error for `missing` keys, saying what to do instead.
pub fn missing_keys_error(env: &str, missing: &[&str]) -> String {
    format!(
        "THEODORE_BUILD_ENV={env} needs the keys CI bakes into a release, and these are missing: {}.\n\
         A build without them has no sign-in and no diagnostics, so it must not call itself {env}.\n\
         - To use Theodore: install the release .dmg (https://github.com/JeanIsahakyan/theodore/releases/latest).\n\
         - To develop: build without THEODORE_BUILD_ENV (a dev build).\n\
         - To build it anyway, marked as incomplete: THEODORE_ALLOW_INCOMPLETE_BUILD=1.",
        missing.join(", ")
    )
}

/// The first 7 characters of the sha, keeping a `-dirty` suffix.
pub fn short_commit(commit: &str) -> String {
    let (sha, dirty) = match commit.strip_suffix("-dirty") {
        Some(sha) => (sha, "-dirty"),
        None => (commit, ""),
    };
    let short: String = sha.chars().take(7).collect();
    format!("{short}{dirty}")
}

/// `0.0.1 · a1b2c3d · staging`: the line About shows and bug reports quote.
pub fn label(version: &str, commit: &str, env: &str) -> String {
    format!("{version} · {} · {env}", short_commit(commit))
}

#[cfg(test)]
mod tests {

    #[test]
    fn a_release_needs_every_key_a_nightly_only_the_account() {
        let none = |_: &str| None;
        assert_eq!(missing_keys("production", none), RELEASE_KEYS.to_vec());
        assert_eq!(missing_keys("staging", none), RELEASE_KEYS.to_vec());
        assert_eq!(
            missing_keys("nightly", none),
            vec!["THEODORE_WORKOS_CLIENT_ID"]
        );
        assert!(missing_keys("dev", none).is_empty());
        let all = |_: &str| Some("x".to_string());
        assert!(missing_keys("production", all).is_empty());
        // Blank counts as missing.
        let blank = |k: &str| {
            Some(
                if k == "THEODORE_POSTHOG_KEY" {
                    " "
                } else {
                    "x"
                }
                .to_string(),
            )
        };
        assert_eq!(
            missing_keys("production", blank),
            vec!["THEODORE_POSTHOG_KEY"]
        );
    }

    #[test]
    fn the_error_says_what_to_do_instead() {
        let e = missing_keys_error("production", &["THEODORE_WORKOS_CLIENT_ID"]);
        assert!(e.contains("THEODORE_WORKOS_CLIENT_ID"));
        assert!(e.contains("releases/latest"));
        assert!(e.contains("THEODORE_ALLOW_INCOMPLETE_BUILD=1"));
    }
    use super::*;

    #[test]
    fn build_env_defaults_to_dev_and_rejects_typos() {
        assert_eq!(build_env(None), Ok("dev"));
        assert_eq!(build_env(Some("  ")), Ok("dev"));
        assert_eq!(build_env(Some("Staging\n")), Ok("staging"));
        assert_eq!(build_env(Some("prod")), Ok("production"));
        assert_eq!(build_env(Some("production")), Ok("production"));
        assert_eq!(build_env(Some("nightly")), Ok("nightly"));
        assert!(build_env(Some("stagin")).unwrap_err().contains("stagin"));
    }

    #[test]
    fn commit_is_dirty_only_in_dev() {
        let sha = "A1B2C3D4E5F60718293a4b5c6d7e8f9012345678";
        let lower = sha.to_ascii_lowercase();
        assert_eq!(commit(Some(sha), false, "dev"), lower);
        assert_eq!(commit(Some(sha), true, "dev"), format!("{lower}-dirty"));
        assert_eq!(commit(Some(sha), true, "production"), lower);
        assert_eq!(commit(None, true, "dev"), "unknown");
        assert_eq!(commit(Some(" "), false, "dev"), "unknown");
    }

    #[test]
    fn short_commit_keeps_the_dirty_mark() {
        assert_eq!(short_commit("a1b2c3d4e5f6"), "a1b2c3d");
        assert_eq!(short_commit("a1b2c3d4e5f6-dirty"), "a1b2c3d-dirty");
        assert_eq!(short_commit("unknown"), "unknown");
    }

    #[test]
    fn label_reads_version_commit_env() {
        assert_eq!(
            label("0.0.1", "a1b2c3d4e5f6", "staging"),
            "0.0.1 · a1b2c3d · staging"
        );
    }
}
