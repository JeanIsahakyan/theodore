//! Several accounts of one agent CLI (docs/plan.md "Agent accounts and
//! limits"): each extra account is its own config directory, handed to the
//! CLI through its env.
//!
//! ```text
//! claude  CLAUDE_CONFIG_DIR=<dir>   credentials, settings, sessions all
//!                                   under <dir> (its keychain item is
//!                                   "Claude Code-credentials-<sha256(dir)[..8]>")
//! codex   CODEX_HOME=<dir>          auth.json, config.toml, sessions
//! gemini  no config-dir switch      an API key in <dir>/.env, read here
//!                                   and passed as GEMINI_API_KEY
//! ```
//!
//! The default account sets nothing: setting `CLAUDE_CONFIG_DIR` to
//! `~/.claude` would move Claude Code's keychain item and sign it out. An
//! extra account also drops the auth variables the parent env carries
//! (`ANTHROPIC_API_KEY`…), which the CLI would otherwise prefer over the
//! account's own sign-in.

use std::path::{Path, PathBuf};

use theodore_domain::AgentId;
use theodore_ports::agent::AgentAccountRef;

/// Claude Code's config-dir variable (and the one that overrides only where
/// it keeps credentials, dropped so the account's own dir decides).
pub const CLAUDE_CONFIG_DIR: &str = "CLAUDE_CONFIG_DIR";
const CLAUDE_SECURESTORAGE_DIR: &str = "CLAUDE_SECURESTORAGE_CONFIG_DIR";
/// Codex's home (`-p, --profile` "Layer $CODEX_HOME/<name>.config.toml").
pub const CODEX_HOME: &str = "CODEX_HOME";

/// What each CLI takes instead of its sign-in: an extra account runs
/// without them.
const CLAUDE_AUTH_ENV: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
];
const CODEX_AUTH_ENV: &[&str] = &["CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "OPENAI_API_KEY"];
const GEMINI_AUTH_ENV: &[&str] = &[
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_GENAI_USE_VERTEXAI",
    "GOOGLE_GENAI_USE_GCA",
];
/// The keys a Gemini account's `.env` may hold.
const GEMINI_KEYS: &[&str] = &["GEMINI_API_KEY", "GOOGLE_API_KEY"];

/// The extra account's directory, `None` for the default one.
pub fn extra_dir(account: Option<&AgentAccountRef>) -> Option<&Path> {
    account.and_then(|a| a.dir.as_deref())
}

/// Points `env` (a run's, already filtered) at `account`: nothing for the
/// default account.
pub fn apply_env(
    agent: AgentId,
    account: Option<&AgentAccountRef>,
    env: &mut Vec<(String, String)>,
) {
    let Some(dir) = extra_dir(account) else {
        return;
    };
    let drop = |env: &mut Vec<(String, String)>, keys: &[&str]| {
        env.retain(|(k, _)| !keys.contains(&k.as_str()));
    };
    match agent {
        AgentId::Claude => {
            drop(env, CLAUDE_AUTH_ENV);
            drop(env, &[CLAUDE_CONFIG_DIR, CLAUDE_SECURESTORAGE_DIR]);
            env.push((CLAUDE_CONFIG_DIR.into(), dir.display().to_string()));
        }
        AgentId::Codex => {
            drop(env, CODEX_AUTH_ENV);
            drop(env, &[CODEX_HOME]);
            env.push((CODEX_HOME.into(), dir.display().to_string()));
        }
        AgentId::Gemini => {
            drop(env, GEMINI_AUTH_ENV);
            env.extend(gemini_keys(dir));
        }
    }
}

/// The API keys in a Gemini account's `<dir>/.env` (`KEY=value` lines,
/// `export` and quotes allowed).
pub fn gemini_keys(dir: &Path) -> Vec<(String, String)> {
    let Ok(text) = std::fs::read_to_string(dir.join(".env")) else {
        return Vec::new();
    };
    text.lines()
        .filter_map(|l| {
            let l = l.trim().trim_start_matches("export ").trim_start();
            let (k, v) = l.split_once('=')?;
            let (k, v) = (k.trim(), v.trim().trim_matches(['"', '\'']));
            (GEMINI_KEYS.contains(&k) && !v.is_empty()).then(|| (k.to_string(), v.to_string()))
        })
        .collect()
}

/// Where the default account keeps its files (`theodore_ports::default_account_dir`).
pub fn default_dir(agent: AgentId) -> Option<PathBuf> {
    theodore_ports::default_account_dir(agent)
}

/// The account's own directory: its dir, or the default one.
pub fn dir_of(agent: AgentId, account: Option<&AgentAccountRef>) -> Option<PathBuf> {
    extra_dir(account)
        .map(Path::to_path_buf)
        .or_else(|| default_dir(agent))
}

/// Claude Code's project directory name for `cwd`: every character that
/// isn't an ASCII letter or digit becomes `-` (Claude Code 2.1.329,
/// `e.replace(/[^a-zA-Z0-9]/g,"-")`; names past 200 characters also get a
/// hash suffix, which [`find_claude_session`] finds by scanning).
pub fn claude_project_dir(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// Claude Code's memory directories for a run in `cwd` under config dir
/// `config`: `<config>/projects/<key>/memory` for every project key the
/// run may use (docs/spaces.md §5). Claude Code keys a plain checkout by
/// its cwd, but a git worktree by its repository's common dir (for a space,
/// the bare mirror under `~/.theodore/repos`), so each spelling of both is
/// a candidate: as given and with symlinks resolved. Nothing else is: no
/// other project's memory is ever named here.
///
/// ```text
/// cwd  ~/.theodore/spaces/<id>            ─▶ -Users-ada--theodore-spaces-<id>
///   .git: gitdir: <mirror>/worktrees/<id>
///   <gitdir>/commondir: ../..             ─▶ -Users-ada--theodore-repos-github-<owner>-<repo>-git
/// ```
pub fn claude_memory_dirs(config: &Path, cwd: &Path) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    let mut add = |p: &Path| {
        let dir = config
            .join("projects")
            .join(claude_project_dir(&p.display().to_string()))
            .join("memory");
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    };
    add(cwd);
    if let Ok(real) = std::fs::canonicalize(cwd) {
        add(&real);
    }
    if let Some(common) = git_common_dir(cwd) {
        add(&common);
        if let Ok(real) = std::fs::canonicalize(&common) {
            add(&real);
        }
    }
    dirs
}

/// The repository common dir of a linked worktree at `cwd` (`<cwd>/.git`
/// is a `gitdir:` file, `<gitdir>/commondir` points at it), lexically
/// normalized. `None` for a plain checkout or no repository: there the cwd
/// itself is the key.
fn git_common_dir(cwd: &Path) -> Option<PathBuf> {
    let link = std::fs::read_to_string(cwd.join(".git")).ok()?;
    let gitdir = link.strip_prefix("gitdir:")?.trim();
    let gitdir = cwd.join(gitdir);
    let common = std::fs::read_to_string(gitdir.join("commondir")).ok()?;
    Some(normalize(&gitdir.join(common.trim())))
}

/// `p` without `.` and `..` components, lexically.
fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}

/// The session file `<config>/projects/<dir>/<session>.jsonl` of a session
/// that ran in `cwd`: its own project dir first (as given, then resolved),
/// else whichever project dir holds it.
pub fn find_claude_session(config: &Path, cwd: &Path, session: &str) -> Option<PathBuf> {
    let projects = config.join("projects");
    let file = format!("{session}.jsonl");
    let mut names = vec![claude_project_dir(&cwd.display().to_string())];
    if let Ok(real) = std::fs::canonicalize(cwd) {
        names.push(claude_project_dir(&real.display().to_string()));
    }
    if let Some(found) = names
        .iter()
        .map(|n| projects.join(n).join(&file))
        .find(|p| p.is_file())
    {
        return Some(found);
    }
    std::fs::read_dir(&projects)
        .ok()?
        .filter_map(Result::ok)
        .map(|e| e.path().join(&file))
        .find(|p| p.is_file())
}

/// Copies Claude session `session` (run in `cwd`) from config dir `from`
/// to `to`, under the same project dir name, with its `<session>/` folder
/// (subagent transcripts, tool results) when it has one, so `--resume
/// <session>` with `to` continues it. `Ok(false)`: no such session in
/// `from`. An existing copy in `to` is replaced (it's older).
pub fn copy_claude_session(
    from: &Path,
    to: &Path,
    cwd: &Path,
    session: &str,
) -> std::io::Result<bool> {
    if session.is_empty() || session.contains(['/', '\\']) || session.starts_with('.') {
        return Ok(false);
    }
    let Some(src) = find_claude_session(from, cwd, session) else {
        return Ok(false);
    };
    let Some(project) = src.parent().and_then(Path::file_name) else {
        return Ok(false);
    };
    let dest_dir = to.join("projects").join(project);
    std::fs::create_dir_all(&dest_dir)?;
    std::fs::copy(&src, dest_dir.join(format!("{session}.jsonl")))?;
    let folder = src.with_extension("");
    if folder.is_dir() {
        copy_dir(&folder, &dest_dir.join(session))?;
    }
    Ok(true)
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let dest = to.join(entry.file_name());
        if kind.is_dir() {
            copy_dir(&entry.path(), &dest)?;
        } else if kind.is_file() {
            std::fs::copy(entry.path(), dest)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn extra(dir: &Path) -> AgentAccountRef {
        AgentAccountRef {
            id: "work".into(),
            dir: Some(dir.to_path_buf()),
        }
    }

    fn env_of(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn get<'a>(env: &'a [(String, String)], key: &str) -> Option<&'a str> {
        env.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }

    #[test]
    fn the_default_account_changes_nothing() {
        let base = env_of(&[("ANTHROPIC_API_KEY", "k"), ("PATH", "/bin")]);
        for agent in AgentId::ALL {
            let mut env = base.clone();
            apply_env(agent, None, &mut env);
            assert_eq!(env, base);
            apply_env(agent, Some(&AgentAccountRef::default_account()), &mut env);
            assert_eq!(env, base, "{agent:?}");
        }
    }

    #[test]
    fn an_extra_claude_account_is_its_config_dir_and_nothing_else() {
        let mut env = env_of(&[
            ("ANTHROPIC_API_KEY", "k"),
            ("CLAUDE_CONFIG_DIR", "/elsewhere"),
            ("CLAUDE_SECURESTORAGE_CONFIG_DIR", "/x"),
            ("PATH", "/bin"),
        ]);
        apply_env(
            AgentId::Claude,
            Some(&extra(Path::new("/d/work"))),
            &mut env,
        );
        assert_eq!(get(&env, "CLAUDE_CONFIG_DIR"), Some("/d/work"));
        assert_eq!(get(&env, "ANTHROPIC_API_KEY"), None);
        assert_eq!(get(&env, "CLAUDE_SECURESTORAGE_CONFIG_DIR"), None);
        assert_eq!(get(&env, "PATH"), Some("/bin"));
        assert_eq!(
            env.iter().filter(|(k, _)| k == "CLAUDE_CONFIG_DIR").count(),
            1
        );
    }

    #[test]
    fn an_extra_codex_account_is_its_home() {
        let mut env = env_of(&[("OPENAI_API_KEY", "k"), ("CODEX_HOME", "/old")]);
        apply_env(AgentId::Codex, Some(&extra(Path::new("/d/c"))), &mut env);
        assert_eq!(env, env_of(&[("CODEX_HOME", "/d/c")]));
    }

    #[test]
    fn an_extra_gemini_account_is_the_key_in_its_env_file() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(".env"),
            "# mine\nexport GEMINI_API_KEY=\"abc\"\nOTHER=1\n",
        )
        .unwrap();
        let mut env = env_of(&[("GEMINI_API_KEY", "parent"), ("HOME", "/h")]);
        apply_env(AgentId::Gemini, Some(&extra(dir.path())), &mut env);
        assert_eq!(get(&env, "GEMINI_API_KEY"), Some("abc"));
        assert_eq!(get(&env, "HOME"), Some("/h"));
        assert!(gemini_keys(Path::new("/no/such/dir")).is_empty());
    }

    #[test]
    fn project_dirs_follow_claude_codes_encoding() {
        assert_eq!(
            claude_project_dir("/Users/ada/.theodore/spaces/ab_12"),
            "-Users-ada--theodore-spaces-ab-12"
        );
    }

    #[test]
    fn memory_dirs_are_the_cwd_key_and_the_worktrees_common_dir_key() {
        let tmp = tempfile::tempdir().unwrap();
        let config = Path::new("/cfg");
        let projects = config.join("projects");

        // No repository: the cwd key only (plus its resolved spelling).
        let plain = tmp.path().join("plain");
        std::fs::create_dir_all(&plain).unwrap();
        let dirs = claude_memory_dirs(config, &plain);
        assert_eq!(
            dirs[0],
            projects
                .join(claude_project_dir(&plain.display().to_string()))
                .join("memory")
        );
        assert!(dirs.len() <= 2, "{dirs:?}");
        assert!(claude_memory_dirs(config, Path::new("/no/such/dir")).len() == 1);

        // A linked worktree of a bare mirror: the mirror's key too.
        let mirror = tmp.path().join("repos/github/ada/app.git");
        let wt = tmp.path().join("spaces/s1");
        std::fs::create_dir_all(mirror.join("worktrees/s1")).unwrap();
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::write(mirror.join("worktrees/s1/commondir"), "../..\n").unwrap();
        std::fs::write(
            wt.join(".git"),
            format!("gitdir: {}\n", mirror.join("worktrees/s1").display()),
        )
        .unwrap();
        let dirs = claude_memory_dirs(config, &wt);
        let key = |p: &Path| {
            projects
                .join(claude_project_dir(&p.display().to_string()))
                .join("memory")
        };
        assert!(dirs.contains(&key(&wt)), "{dirs:?}");
        assert!(dirs.contains(&key(&mirror)), "{dirs:?}");
        assert!(
            dirs.contains(&key(&mirror.canonicalize().unwrap())),
            "{dirs:?}"
        );
        // The owner's directory, or any other project, is never a key.
        assert!(!dirs.contains(&key(mirror.parent().unwrap())));
        assert!(dirs.len() <= 4, "{dirs:?}");
    }

    #[test]
    fn a_session_is_copied_with_its_folder_and_found_by_scanning() {
        let from = tempfile::tempdir().unwrap();
        let to = tempfile::tempdir().unwrap();
        let cwd = Path::new("/work/spaces/s1");
        let project = from
            .path()
            .join("projects")
            .join(claude_project_dir("/work/spaces/s1"));
        std::fs::create_dir_all(project.join("abc/subagents")).unwrap();
        std::fs::write(project.join("abc.jsonl"), "{\"type\":\"user\"}\n").unwrap();
        std::fs::write(project.join("abc/subagents/a.jsonl"), "x").unwrap();

        assert!(copy_claude_session(from.path(), to.path(), cwd, "abc").unwrap());
        let dest = to.path().join("projects").join("-work-spaces-s1");
        assert_eq!(
            std::fs::read_to_string(dest.join("abc.jsonl")).unwrap(),
            "{\"type\":\"user\"}\n"
        );
        assert!(dest.join("abc/subagents/a.jsonl").is_file());

        // Another cwd spelling (a resolved symlink): found by scanning.
        assert!(copy_claude_session(from.path(), to.path(), Path::new("/x"), "abc").unwrap());
        assert!(!copy_claude_session(from.path(), to.path(), cwd, "nope").unwrap());
        assert!(!copy_claude_session(from.path(), to.path(), cwd, "../abc").unwrap());
    }
}
