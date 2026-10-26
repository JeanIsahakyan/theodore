//! What this binary is: version, commit and build environment, baked in
//! by `build.rs` (docs/releasing.md "Build stamp"). Settings → About, the
//! problem report and every telemetry record carry them.

use crate::build_stamp;

/// The app version; a nightly's `-nightly.N` included.
pub const VERSION: &str = env!("THEODORE_VERSION");
/// The full commit sha, `-dirty` for a dev build from uncommitted changes,
/// `unknown` when built without git.
pub const COMMIT: &str = env!("THEODORE_COMMIT");
/// `production` | `staging` | `nightly` | `dev`.
pub const BUILD_ENV: &str = env!("THEODORE_BUILD_ENV");
const BUILT_AT: &str = env!("THEODORE_BUILT_AT");

/// Unix millis of the build (0 if the stamp is unreadable).
pub fn built_at() -> i64 {
    BUILT_AT.parse().unwrap_or(0)
}

/// `0.0.1 · a1b2c3d · staging`.
pub fn label() -> String {
    build_stamp::label(VERSION, COMMIT, BUILD_ENV)
}

/// What the macOS About panel shows after the version, in parentheses:
/// `a1b2c3d · staging`, so it says the same as Settings → About.
pub fn about_detail() -> String {
    format!("{} · {BUILD_ENV}", build_stamp::short_commit(COMMIT))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_stamp_is_baked_in() {
        assert!(!VERSION.is_empty());
        assert!(build_stamp::BUILD_ENVS.contains(&BUILD_ENV));
        assert!(!COMMIT.is_empty());
        assert!(built_at() > 0);
        assert!(label().starts_with(VERSION));
    }
}
