//! Which shell is "the user's shell": `$SHELL`, else a fallback that exists.
//! macOS ships zsh, so it is the first fallback there; Linux has no such
//! default, so it falls to bash, then `/bin/sh` (always present).

use std::path::Path;

/// Where a shell is looked for when `$SHELL` is unset or points at nothing.
fn fallbacks(macos: bool) -> &'static [&'static str] {
    if macos {
        &["/bin/zsh", "/bin/bash", "/bin/sh"]
    } else {
        &["/bin/bash", "/usr/bin/bash", "/bin/sh"]
    }
}

/// The first usable shell: `shell_env` when it names an existing file,
/// else the first fallback that exists, else `/bin/sh`. Pure given
/// `exists`, so the choice is testable without the real filesystem.
pub fn choose(shell_env: Option<&str>, macos: bool, exists: impl Fn(&Path) -> bool) -> String {
    let set = shell_env.map(str::trim).filter(|s| !s.is_empty());
    set.into_iter()
        .chain(fallbacks(macos).iter().copied())
        .find(|s| exists(Path::new(s)))
        .unwrap_or("/bin/sh")
        .to_string()
}

/// The shell for this process: `$SHELL` if it exists, else the platform's
/// fallback (`choose`).
pub fn login_shell() -> String {
    choose(
        std::env::var("SHELL").ok().as_deref(),
        cfg!(target_os = "macos"),
        Path::is_file,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn only(have: &'static [&'static str]) -> impl Fn(&Path) -> bool {
        move |p| have.iter().any(|h| Path::new(h) == p)
    }

    #[test]
    fn the_users_shell_wins_when_it_exists() {
        let have = only(&["/usr/bin/fish", "/bin/bash", "/bin/sh"]);
        assert_eq!(choose(Some("/usr/bin/fish"), false, have), "/usr/bin/fish");
    }

    #[test]
    fn linux_falls_back_to_bash_then_sh() {
        assert_eq!(
            choose(None, false, only(&["/bin/bash", "/bin/sh"])),
            "/bin/bash"
        );
        assert_eq!(
            choose(Some("/gone/fish"), false, only(&["/usr/bin/bash"])),
            "/usr/bin/bash"
        );
        assert_eq!(choose(Some(" "), false, only(&["/bin/sh"])), "/bin/sh");
    }

    #[test]
    fn macos_prefers_zsh_without_a_shell_var() {
        let have = only(&["/bin/zsh", "/bin/bash", "/bin/sh"]);
        assert_eq!(choose(None, true, have), "/bin/zsh");
    }

    #[test]
    fn nothing_found_is_sh() {
        assert_eq!(choose(None, false, |_| false), "/bin/sh");
    }
}
