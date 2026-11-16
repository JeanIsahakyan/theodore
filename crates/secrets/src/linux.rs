//! Linux backend: the vault as one Secret Service item (GNOME Keyring,
//! KWallet, KeePassXC) through `secret-tool`, or a file when none is reachable.
//!
//! Why `secret-tool` (package `libsecret-tools`, `libsecret` on Arch/Fedora)
//! and not the `keyring` crate: it is the same shape as macOS's
//! `/usr/bin/security` (spawn, secret on stdin), needs no D-Bus or crypto
//! crates and no `-dev` headers to build, and the whole thing stays testable
//! through an injected runner.
//!
//! Item: attributes `service` = the build's service string, `account` =
//! `vault`; the secret is the JSON vault. It goes through stdin, never argv.
//!
//! Fallback (headless server, no D-Bus session, no keyring daemon, or
//! `secret-tool` not installed): the same JSON in
//! `<dir>/<service>.vault`, mode 0600 in a 0700 dir, where `<dir>` is
//! `KeychainSecrets::with_fallback_dir` or `$XDG_DATA_HOME/theodore`
//! (`~/.local/share/theodore`). Plain text on disk: its protection is file
//! permissions only. A warning is logged once, when the process first falls
//! back.
//!
//! The backend is decided on the first call and then sticks for the process:
//! a Secret Service that works is never silently swapped for the file, and
//! data written to the file is not migrated if a keyring shows up later.

use super::CommandRunner;
use std::io::{self, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use theodore_ports::SecretsError;

const TOOL: &str = "secret-tool";

/// What a finished `secret-tool` run left behind.
pub(crate) struct ToolOutput {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// Runs `secret-tool <args>` with an optional stdin (injected in tests).
pub(crate) trait ToolRunner: Send + Sync {
    fn run(&self, args: &[&str], stdin: Option<&str>) -> io::Result<ToolOutput>;
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
struct RealTool;

impl ToolRunner for RealTool {
    fn run(&self, args: &[&str], stdin: Option<&str>) -> io::Result<ToolOutput> {
        // No session bus: `secret-tool` would try to autolaunch one and fail
        // slowly. Treat it as "no Secret Service" without spawning.
        if !session_bus_present() {
            return Err(io::Error::new(
                io::ErrorKind::NotConnected,
                "no D-Bus session bus",
            ));
        }
        let mut child = Command::new(TOOL)
            .args(args)
            .stdin(if stdin.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        if let (Some(text), Some(mut pipe)) = (stdin, child.stdin.take()) {
            pipe.write_all(text.as_bytes())?;
        }
        let out = child.wait_with_output()?;
        Ok(ToolOutput {
            code: out.status.code(),
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        })
    }
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn session_bus_present() -> bool {
    std::env::var_os("DBUS_SESSION_BUS_ADDRESS").is_some_and(|v| !v.is_empty())
        || std::env::var_os("XDG_RUNTIME_DIR").is_some_and(|d| Path::new(&d).join("bus").exists())
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Backend {
    SecretService,
    File,
}

/// Why a `secret-tool` call did not produce an answer.
enum ToolFailure {
    /// No Secret Service to talk to.
    Unavailable(String),
    Denied,
}

pub(crate) struct LinuxRunner {
    tool: Box<dyn ToolRunner>,
    dir: Option<PathBuf>,
    /// `None` until the first call decides.
    backend: Mutex<Option<Backend>>,
}

impl LinuxRunner {
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub(crate) fn new(dir: Option<PathBuf>) -> Self {
        Self::with_tool(Box::new(RealTool), dir)
    }

    pub(crate) fn with_tool(tool: Box<dyn ToolRunner>, dir: Option<PathBuf>) -> Self {
        Self {
            tool,
            dir,
            backend: Mutex::new(None),
        }
    }

    fn file_path(&self, service: &str) -> Result<PathBuf, SecretsError> {
        let dir = match &self.dir {
            Some(d) => d.clone(),
            None => dirs::data_dir()
                .ok_or_else(|| SecretsError::Keychain("no data directory for secrets".into()))?
                .join("theodore"),
        };
        let name: String = service
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        Ok(dir.join(format!("{name}.vault")))
    }

    fn lookup(&self, service: &str, account: &str) -> Result<Option<String>, ToolFailure> {
        let out = self
            .tool
            .run(&["lookup", "service", service, "account", account], None)
            .map_err(spawn_failure)?;
        if out.code == Some(0) {
            let value = out.stdout.trim_end().to_string();
            return Ok((!value.is_empty()).then_some(value));
        }
        let err = out.stderr.trim();
        if err.is_empty() {
            // `secret-tool lookup` exits 1 with no output when nothing matches.
            return Ok(None);
        }
        Err(classify(err))
    }

    fn store(&self, service: &str, account: &str, value: &str) -> Result<(), ToolFailure> {
        let label = format!("Theodore secrets ({service})");
        let out = self
            .tool
            .run(
                &[
                    "store",
                    &format!("--label={label}"),
                    "service",
                    service,
                    "account",
                    account,
                ],
                Some(value),
            )
            .map_err(spawn_failure)?;
        if out.code == Some(0) {
            return Ok(());
        }
        Err(classify(out.stderr.trim()))
    }

    fn fall_back(why: &str) -> Backend {
        tracing::warn!(
            "no Secret Service ({why}); keeping secrets in a 0600 file under the data dir instead"
        );
        Backend::File
    }
}

fn spawn_failure(e: io::Error) -> ToolFailure {
    if e.kind() == io::ErrorKind::NotFound {
        ToolFailure::Unavailable(format!("{TOOL} is not installed (libsecret-tools)"))
    } else {
        ToolFailure::Unavailable(e.to_string())
    }
}

fn classify(stderr: &str) -> ToolFailure {
    let lower = stderr.to_ascii_lowercase();
    if lower.contains("dismissed") || lower.contains("cancel") {
        ToolFailure::Denied
    } else {
        ToolFailure::Unavailable(stderr.to_string())
    }
}

fn keychain_err(why: &str) -> SecretsError {
    SecretsError::Keychain(format!("{TOOL}: {why}"))
}

impl CommandRunner for LinuxRunner {
    fn read_keychain(&self, service: &str, account: &str) -> Result<Option<String>, SecretsError> {
        let mut backend = self
            .backend
            .lock()
            .map_err(|_| SecretsError::Keychain("mutex poisoned".into()))?;
        if *backend != Some(Backend::File) {
            match self.lookup(service, account) {
                Ok(v) => {
                    *backend = Some(Backend::SecretService);
                    return Ok(v);
                }
                Err(ToolFailure::Denied) => return Err(SecretsError::Denied),
                Err(ToolFailure::Unavailable(why)) => {
                    if backend.is_some() {
                        return Err(keychain_err(&why));
                    }
                    *backend = Some(Self::fall_back(&why));
                }
            }
        }
        read_file(&self.file_path(service)?)
    }

    fn write_keychain(
        &self,
        service: &str,
        account: &str,
        value: &str,
    ) -> Result<(), SecretsError> {
        let mut backend = self
            .backend
            .lock()
            .map_err(|_| SecretsError::Keychain("mutex poisoned".into()))?;
        if *backend != Some(Backend::File) {
            match self.store(service, account, value) {
                Ok(()) => {
                    *backend = Some(Backend::SecretService);
                    return Ok(());
                }
                Err(ToolFailure::Denied) => return Err(SecretsError::Denied),
                Err(ToolFailure::Unavailable(why)) => {
                    if backend.is_some() {
                        return Err(keychain_err(&why));
                    }
                    *backend = Some(Self::fall_back(&why));
                }
            }
        }
        write_file(&self.file_path(service)?, value)
    }
}

fn io_err(what: &str, path: &Path, e: io::Error) -> SecretsError {
    SecretsError::Keychain(format!("{what} {}: {e}", path.display()))
}

fn read_file(path: &Path) -> Result<Option<String>, SecretsError> {
    match std::fs::read_to_string(path) {
        Ok(s) => {
            let s = s.trim_end().to_string();
            Ok((!s.is_empty()).then_some(s))
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(io_err("read", path, e)),
    }
}

/// Atomic: a 0600 temp file next to the target, then rename over it. A crash
/// leaves the old vault, never a torn one.
fn write_file(path: &Path, value: &str) -> Result<(), SecretsError> {
    let dir = path
        .parent()
        .ok_or_else(|| SecretsError::Keychain("fallback path has no parent".into()))?;
    if !dir.exists() {
        if let Some(parent) = dir.parent() {
            std::fs::create_dir_all(parent).map_err(|e| io_err("create", parent, e))?;
        }
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(dir)
            .map_err(|e| io_err("create", dir, e))?;
    }
    let tmp = path.with_extension("vault.tmp");
    // A stale temp from a crash would keep its old mode through `truncate`.
    let _ = std::fs::remove_file(&tmp);
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&tmp)
        .map_err(|e| io_err("create", &tmp, e))?;
    let written = file
        .write_all(value.as_bytes())
        .and_then(|()| file.sync_all())
        .map_err(|e| io_err("write", &tmp, e));
    drop(file);
    if let Err(e) = written {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    std::fs::rename(&tmp, path).map_err(|e| io_err("rename to", path, e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{KeychainSecrets, Secrets};
    use std::os::unix::fs::PermissionsExt;
    use std::sync::Arc;

    /// Fake `secret-tool`: a one-item store, or an unavailable service.
    #[derive(Default)]
    struct FakeTool {
        /// `Some(stderr)`: every call exits 1 with that stderr.
        fail: Mutex<Option<String>>,
        /// `true`: the binary does not exist.
        missing: Mutex<bool>,
        item: Mutex<Option<String>>,
        calls: Mutex<Vec<(Vec<String>, Option<String>)>>,
    }

    impl ToolRunner for Arc<FakeTool> {
        fn run(&self, args: &[&str], stdin: Option<&str>) -> io::Result<ToolOutput> {
            self.calls.lock().unwrap().push((
                args.iter().map(|a| a.to_string()).collect(),
                stdin.map(String::from),
            ));
            if *self.missing.lock().unwrap() {
                return Err(io::Error::from(io::ErrorKind::NotFound));
            }
            let ok = |stdout: &str| {
                Ok(ToolOutput {
                    code: Some(0),
                    stdout: stdout.into(),
                    stderr: String::new(),
                })
            };
            if let Some(stderr) = self.fail.lock().unwrap().clone() {
                return Ok(ToolOutput {
                    code: Some(1),
                    stdout: String::new(),
                    stderr,
                });
            }
            match args[0] {
                "store" => {
                    *self.item.lock().unwrap() = stdin.map(String::from);
                    ok("")
                }
                _ => match self.item.lock().unwrap().clone() {
                    Some(v) => ok(&v),
                    None => Ok(ToolOutput {
                        code: Some(1),
                        stdout: String::new(),
                        stderr: String::new(),
                    }),
                },
            }
        }
    }

    fn secrets(tool: &Arc<FakeTool>, dir: &Path) -> KeychainSecrets {
        let mut s = KeychainSecrets::with_service("app.theodore.secrets.test");
        s.runner = Box::new(LinuxRunner::with_tool(
            Box::new(tool.clone()),
            Some(dir.to_path_buf()),
        ));
        s
    }

    #[test]
    fn secret_service_roundtrip_uses_attributes_and_stdin() {
        let tool = Arc::new(FakeTool::default());
        let dir = tempfile::tempdir().unwrap();
        let s = secrets(&tool, dir.path());

        assert_eq!(s.get("k").unwrap(), None);
        s.set("k", "v").unwrap();
        assert_eq!(s.get("k").unwrap(), Some("v".into()));

        let calls = tool.calls.lock().unwrap();
        let (args, stdin) = calls.iter().find(|(a, _)| a[0] == "store").unwrap();
        assert_eq!(
            &args[2..],
            ["service", "app.theodore.secrets.test", "account", "vault"]
        );
        assert_eq!(stdin.as_deref(), Some(r#"{"k":"v"}"#));
        assert!(
            calls
                .iter()
                .all(|(a, _)| a.iter().all(|x| !x.contains(r#""k""#))),
            "the secret must never be an argument"
        );
        // Nothing was written to the fallback dir.
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn missing_tool_falls_back_to_a_private_file() {
        let tool = Arc::new(FakeTool::default());
        *tool.missing.lock().unwrap() = true;
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("theodore");
        let s = secrets(&tool, &dir);

        s.set("k", "v").unwrap();
        s.set("k2", "v2").unwrap();
        assert_eq!(s.get("k").unwrap(), Some("v".into()));

        let file = dir.join("app.theodore.secrets.test.vault");
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&file), 0o600);
        assert_eq!(mode(&dir), 0o700);
        let stored: std::collections::HashMap<String, String> =
            serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(stored["k2"], "v2");

        // A fresh process (new runner) reads the same file back.
        let s2 = secrets(&tool, &dir);
        assert_eq!(s2.get("k2").unwrap(), Some("v2".into()));
        // The backend stuck: after the first failure `secret-tool` is not retried.
        assert_eq!(tool.calls.lock().unwrap().len(), 2, "one probe per runner");
    }

    #[test]
    fn service_error_text_means_unavailable() {
        let tool = Arc::new(FakeTool::default());
        *tool.fail.lock().unwrap() =
            Some("secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY".into());
        let dir = tempfile::tempdir().unwrap();
        let s = secrets(&tool, dir.path());
        s.set("k", "v").unwrap();
        assert_eq!(s.get("k").unwrap(), Some("v".into()));
        assert!(dir.path().join("app.theodore.secrets.test.vault").exists());
    }

    #[test]
    fn dismissed_prompt_is_denied_not_a_fallback() {
        let tool = Arc::new(FakeTool::default());
        *tool.fail.lock().unwrap() = Some("secret-tool: Prompt was dismissed".into());
        let dir = tempfile::tempdir().unwrap();
        let s = secrets(&tool, dir.path());
        assert!(matches!(s.get("k"), Err(SecretsError::Denied)));
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn working_service_that_breaks_later_errors_instead_of_falling_back() {
        let tool = Arc::new(FakeTool::default());
        let dir = tempfile::tempdir().unwrap();
        let s = secrets(&tool, dir.path());
        s.set("k", "v").unwrap();
        *tool.fail.lock().unwrap() = Some("secret-tool: connection lost".into());
        assert!(matches!(s.set("k", "w"), Err(SecretsError::Keychain(_))));
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn service_name_cannot_escape_the_fallback_dir() {
        let runner = LinuxRunner::with_tool(
            Box::new(Arc::new(FakeTool::default())),
            Some(PathBuf::from("/data")),
        );
        assert_eq!(
            runner.file_path("../x/y").unwrap(),
            PathBuf::from("/data/.._x_y.vault")
        );
    }

    #[test]
    fn rewriting_the_file_repairs_loose_permissions() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("v.vault");
        std::fs::write(&file, "{}").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
        write_file(&file, r#"{"a":"b"}"#).unwrap();
        assert_eq!(
            std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(read_file(&file).unwrap(), Some(r#"{"a":"b"}"#.into()));
    }
}
