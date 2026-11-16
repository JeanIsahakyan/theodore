//! Whether each CLI has credentials (docs/fleet.md "Sign-in"), so a device
//! only offers the agents that can actually run.
//!
//! ```text
//! claude  key in env? ─yes─▶ in
//!           └─no─▶ `claude auth status` (JSON) ─▶ loggedIn true/false
//! codex   CODEX_API_KEY / CODEX_ACCESS_TOKEN? ─yes─▶ in
//!           └─no─▶ `codex login status` ─▶ "Logged in using …" ─▶ in
//!                                       └▶ "Not logged in" ─▶ out
//!                                          (OPENAI_API_KEY set: unknown)
//! gemini  key / Vertex / GCA in env, ~/.gemini/oauth_creds.json,
//!         an auth type in ~/.gemini/settings.json, a key in ~/.gemini/.env
//!           ─any─▶ in       ─none─▶ out
//! timeout (CHECK_TIMEOUT), spawn failure, unreadable output ─▶ unknown
//! ```
//!
//! Each check runs with the env a run gets (`env::filtered_env`), never
//! longer than [`CHECK_TIMEOUT`]. `None` is "unknown": usable, unconfirmed.

use std::path::Path;
use std::time::Duration;

use theodore_domain::AgentId;

/// The longest a status command may take.
pub const CHECK_TIMEOUT: Duration = Duration::from_secs(5);

/// Whether `key` is set to something in `env`.
fn has(env: &[(String, String)], key: &str) -> bool {
    env.iter()
        .any(|(k, v)| k == key && !v.trim().is_empty() && v.trim() != "false" && v.trim() != "0")
}

/// Claude Code takes these instead of a login (an API key, a long-lived
/// token, a cloud provider).
const CLAUDE_ENV: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
];

/// `codex exec` takes these instead of a login (its own error says
/// "run `codex login` or set CODEX_API_KEY").
const CODEX_ENV: &[&str] = &["CODEX_API_KEY", "CODEX_ACCESS_TOKEN"];

/// Gemini CLI's sign-in methods set from the env.
const GEMINI_ENV: &[&str] = &[
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_GENAI_USE_VERTEXAI",
    "GOOGLE_GENAI_USE_GCA",
];

/// `claude auth status` (JSON by default): its `loggedIn`. Text that says
/// "not logged in" is a no; anything else can't tell.
pub fn parse_claude_status(stdout: &str) -> Option<bool> {
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(stdout.trim())
        && let Some(b) = v.get("loggedIn").and_then(|b| b.as_bool())
    {
        return Some(b);
    }
    stdout
        .to_ascii_lowercase()
        .contains("not logged in")
        .then_some(false)
}

/// `codex login status`: "Logged in using ChatGPT" / "… an API key" (exit
/// 0), "Not logged in" (exit 1), on stdout or stderr by version.
pub fn parse_codex_status(output: &str, success: bool) -> Option<bool> {
    let text = output.to_ascii_lowercase();
    if text.contains("not logged in") {
        Some(false)
    } else if success && text.contains("logged in") {
        Some(true)
    } else {
        None
    }
}

/// Whether Gemini CLI has a sign-in method: from the env, else the files
/// it keeps under `<home>/.gemini`.
pub fn gemini_signed_in(env: &[(String, String)], home: &Path) -> bool {
    if GEMINI_ENV.iter().any(|k| has(env, k)) {
        return true;
    }
    let dir = home.join(".gemini");
    if dir.join("oauth_creds.json").is_file() {
        return true;
    }
    if let Ok(text) = std::fs::read_to_string(dir.join("settings.json"))
        && settings_auth_type(&text)
    {
        return true;
    }
    if let Ok(text) = std::fs::read_to_string(dir.join(".env")) {
        return text.lines().any(|l| {
            let l = l.trim().trim_start_matches("export ").trim_start();
            GEMINI_ENV.iter().any(|k| {
                l.strip_prefix(k)
                    .and_then(|r| r.trim_start().strip_prefix('='))
                    .is_some_and(|v| !v.trim().trim_matches(['"', '\'']).is_empty())
            })
        });
    }
    false
}

/// A `settings.json` that picked an auth type: `security.auth.selectedType`
/// (current Gemini CLI) or `selectedAuthType` (earlier ones). A file that
/// isn't plain JSON (comments) is read for the key itself.
fn settings_auth_type(text: &str) -> bool {
    let set = |v: Option<&serde_json::Value>| {
        v.and_then(|v| v.as_str())
            .is_some_and(|s| !s.trim().is_empty())
    };
    match serde_json::from_str::<serde_json::Value>(text) {
        Ok(v) => set(v.pointer("/security/auth/selectedType")) || set(v.get("selectedAuthType")),
        Err(_) => text.contains("\"selectedType\"") || text.contains("\"selectedAuthType\""),
    }
}

/// Runs `program args` with `env`; `(success, stdout, stderr)`, or `None`
/// on a timeout or spawn failure.
async fn status_output(
    program: &Path,
    args: &[&str],
    env: &[(String, String)],
    timeout: Duration,
) -> Option<(bool, String, String)> {
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(args)
        .env_clear()
        .envs(env.iter().cloned())
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    let fut = crate::exit_output::output_after_exit(cmd);
    match tokio::time::timeout(timeout, fut).await {
        Ok(Ok(out)) => Some((
            out.status.success(),
            String::from_utf8_lossy(&out.stdout).into_owned(),
            String::from_utf8_lossy(&out.stderr).into_owned(),
        )),
        Ok(Err(e)) => {
            tracing::debug!(program = %program.display(), error = %e, "sign-in check didn't start");
            None
        }
        Err(_) => {
            tracing::debug!(program = %program.display(), "sign-in check timed out");
            None
        }
    }
}

/// Whether agent `id` (its CLI at `program`) is signed in, run with `env`
/// (a run's); `home`: where Gemini keeps its files. `None`: unknown.
pub async fn check(
    id: AgentId,
    program: &Path,
    env: &[(String, String)],
    home: Option<&Path>,
) -> Option<bool> {
    check_within(id, program, env, home, CHECK_TIMEOUT).await
}

async fn check_within(
    id: AgentId,
    program: &Path,
    env: &[(String, String)],
    home: Option<&Path>,
    timeout: Duration,
) -> Option<bool> {
    match id {
        AgentId::Claude => {
            if CLAUDE_ENV.iter().any(|k| has(env, k)) {
                return Some(true);
            }
            let (_, stdout, stderr) =
                status_output(program, &["auth", "status"], env, timeout).await?;
            parse_claude_status(&stdout).or_else(|| parse_claude_status(&stderr))
        }
        AgentId::Codex => {
            if CODEX_ENV.iter().any(|k| has(env, k)) {
                return Some(true);
            }
            let (ok, stdout, stderr) =
                status_output(program, &["login", "status"], env, timeout).await?;
            match parse_codex_status(&format!("{stdout}\n{stderr}"), ok) {
                // A key the status command doesn't read: it may still run.
                Some(false) if has(env, "OPENAI_API_KEY") => None,
                other => other,
            }
        }
        AgentId::Gemini => Some(gemini_signed_in(env, home?)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn env(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    /// A fake CLI at `<dir>/<name>`: prints `out` to stdout, `err` to
    /// stderr, exits with `code` (after `sleep` seconds).
    fn fake(dir: &Path, name: &str, out: &str, err: &str, code: i32, sleep: u32) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join(name);
        let script = format!(
            "#!/bin/sh\nsleep {sleep}\nprintf '%s' '{out}'\nprintf '%s' '{err}' >&2\nexit {code}\n"
        );
        std::fs::write(&path, script).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    /// The env a test check runs with: enough `PATH` for `sh` and `sleep`.
    fn base() -> Vec<(String, String)> {
        env(&[("PATH", "/usr/bin:/bin")])
    }

    #[test]
    fn claude_status_reads_logged_in() {
        assert_eq!(
            parse_claude_status(r#"{"loggedIn": true, "authMethod": "claude.ai"}"#),
            Some(true)
        );
        assert_eq!(
            parse_claude_status(r#"{"loggedIn": false, "authMethod": "none"}"#),
            Some(false)
        );
        assert_eq!(parse_claude_status("Not logged in"), Some(false));
        assert_eq!(parse_claude_status("error: unknown command 'auth'"), None);
    }

    #[test]
    fn codex_status_reads_its_line() {
        assert_eq!(
            parse_codex_status("Logged in using ChatGPT\n", true),
            Some(true)
        );
        assert_eq!(
            parse_codex_status("Logged in using an API key - sk-…", true),
            Some(true)
        );
        assert_eq!(parse_codex_status("Not logged in\n", false), Some(false));
        assert_eq!(
            parse_codex_status("error: unrecognized subcommand", false),
            None
        );
    }

    #[test]
    fn gemini_is_signed_in_by_env_or_its_files() {
        let home = tempfile::tempdir().unwrap();
        assert!(!gemini_signed_in(&[], home.path()));
        assert!(gemini_signed_in(
            &env(&[("GEMINI_API_KEY", "k")]),
            home.path()
        ));
        assert!(gemini_signed_in(
            &env(&[("GOOGLE_GENAI_USE_VERTEXAI", "true")]),
            home.path()
        ));
        assert!(!gemini_signed_in(
            &env(&[
                ("GOOGLE_GENAI_USE_VERTEXAI", "false"),
                ("GEMINI_API_KEY", " ")
            ]),
            home.path()
        ));

        let dir = home.path().join(".gemini");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("settings.json"), r#"{"theme": "dark"}"#).unwrap();
        assert!(!gemini_signed_in(&[], home.path()), "no auth type");
        std::fs::write(
            dir.join("settings.json"),
            r#"{"security": {"auth": {"selectedType": "oauth-personal"}}}"#,
        )
        .unwrap();
        assert!(gemini_signed_in(&[], home.path()));
        std::fs::write(
            dir.join("settings.json"),
            r#"{"selectedAuthType": "gemini-api-key"}"#,
        )
        .unwrap();
        assert!(gemini_signed_in(&[], home.path()), "the earlier key");
        std::fs::remove_file(dir.join("settings.json")).unwrap();

        std::fs::write(dir.join(".env"), "GEMINI_API_KEY=\n").unwrap();
        assert!(!gemini_signed_in(&[], home.path()), "an empty key");
        std::fs::write(dir.join(".env"), "export GEMINI_API_KEY=\"abc\"\n").unwrap();
        assert!(gemini_signed_in(&[], home.path()));
        std::fs::remove_file(dir.join(".env")).unwrap();

        std::fs::write(dir.join("oauth_creds.json"), "{}").unwrap();
        assert!(gemini_signed_in(&[], home.path()));
    }

    #[tokio::test]
    async fn claude_runs_auth_status_unless_a_key_is_set() {
        let dir = tempfile::tempdir().unwrap();
        let yes = fake(dir.path(), "claude-yes", r#"{"loggedIn": true}"#, "", 0, 0);
        let no = fake(dir.path(), "claude-no", r#"{"loggedIn": false}"#, "", 1, 0);
        assert_eq!(
            check(AgentId::Claude, &yes, &base(), None).await,
            Some(true)
        );
        assert_eq!(
            check(AgentId::Claude, &no, &base(), None).await,
            Some(false)
        );
        let mut keyed = base();
        keyed.push(("ANTHROPIC_API_KEY".into(), "sk".into()));
        assert_eq!(check(AgentId::Claude, &no, &keyed, None).await, Some(true));
        let gone = dir.path().join("no-such-claude");
        assert_eq!(check(AgentId::Claude, &gone, &base(), None).await, None);
    }

    #[tokio::test]
    async fn codex_runs_login_status() {
        let dir = tempfile::tempdir().unwrap();
        let yes = fake(dir.path(), "codex-yes", "", "Logged in using ChatGPT", 0, 0);
        let no = fake(dir.path(), "codex-no", "", "Not logged in", 1, 0);
        assert_eq!(check(AgentId::Codex, &yes, &base(), None).await, Some(true));
        assert_eq!(check(AgentId::Codex, &no, &base(), None).await, Some(false));
        let mut keyed = base();
        keyed.push(("CODEX_API_KEY".into(), "sk".into()));
        assert_eq!(check(AgentId::Codex, &no, &keyed, None).await, Some(true));
        let mut openai = base();
        openai.push(("OPENAI_API_KEY".into(), "sk".into()));
        assert_eq!(
            check(AgentId::Codex, &no, &openai, None).await,
            None,
            "a key `login status` doesn't read: can't tell"
        );
    }

    #[tokio::test]
    async fn a_check_that_hangs_is_unknown() {
        let dir = tempfile::tempdir().unwrap();
        let slow = fake(
            dir.path(),
            "codex-slow",
            "",
            "Logged in using ChatGPT",
            0,
            30,
        );
        let started = std::time::Instant::now();
        let within = Duration::from_millis(300);
        assert_eq!(
            check_within(AgentId::Codex, &slow, &base(), None, within).await,
            None
        );
        assert!(started.elapsed() < Duration::from_secs(5));
    }
}
