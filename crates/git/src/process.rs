//! Runs `git` as a child process with no terminal prompting and no secret
//! ever written to disk, argv, or `.git/config`.

use std::path::Path;
use std::process::Stdio;

use tokio::io::AsyncWriteExt;

use theodore_ports::{GitError, GitResult};

/// One invocation of `git`. `token`, if present, is set only on this child
/// process's env and read back by the askpass helper (`auth.rs`); it is
/// never part of `args`.
pub(crate) struct GitProc<'a> {
    pub cwd: &'a Path,
    pub askpass: &'a Path,
    pub args: &'a [&'a str],
    pub token: Option<&'a str>,
    /// Bytes to feed the child's stdin (e.g. shas for `cat-file --batch-check`).
    pub stdin: Option<&'a [u8]>,
}

impl GitProc<'_> {
    /// Builds the child's `Command` without spawning it, so a test can
    /// inspect/drop a real `Child` directly (`run`'s own `Child` never
    /// escapes it). Production code always goes through `run`/`run_text`.
    fn command(&self) -> tokio::process::Command {
        let mut cmd = tokio::process::Command::new("git");
        cmd.current_dir(self.cwd)
            .args(self.args)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_ASKPASS", self.askpass)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_PAGER", "cat")
            .env("LC_ALL", "C")
            .stdin(if self.stdin.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // A cancelled operation (the caller's future dropped) must not
            // leave `git` running: without this, a long `fetch`/`clone` keeps
            // going in the background after Theodore gives up on it.
            .kill_on_drop(true);
        match self.token {
            Some(t) => {
                cmd.env("THEODORE_GIT_TOKEN", t);
                cmd.env("THEODORE_GIT_USER", "x-access-token");
            }
            None => {
                cmd.env_remove("THEODORE_GIT_TOKEN");
            }
        }
        cmd
    }

    pub(crate) async fn run(&self) -> GitResult<Vec<u8>> {
        let mut cmd = self.command();
        let mut child = cmd.spawn().map_err(io_err)?;
        if let (Some(data), Some(mut pipe)) = (self.stdin, child.stdin.take()) {
            pipe.write_all(data).await.map_err(io_err)?;
            // Dropping `pipe` closes the write end so the child sees EOF.
        }
        let output = child.wait_with_output().await.map_err(io_err)?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
            let code = output.status.code().unwrap_or(-1);
            if looks_like_auth_failure(&stderr) {
                return Err(GitError::Auth(stderr));
            }
            return Err(GitError::Command {
                args: self.args.join(" "),
                code,
                stderr,
            });
        }
        Ok(output.stdout)
    }

    pub(crate) async fn run_text(&self) -> GitResult<String> {
        Ok(String::from_utf8_lossy(&self.run().await?).into_owned())
    }
}

fn io_err(e: std::io::Error) -> GitError {
    if e.kind() == std::io::ErrorKind::NotFound {
        GitError::NotInstalled
    } else {
        GitError::Io(e)
    }
}

fn looks_like_auth_failure(stderr: &str) -> bool {
    let s = stderr.to_ascii_lowercase();
    s.contains("authentication failed")
        || s.contains("could not read username")
        || s.contains("could not read password")
        || s.contains("terminal prompts disabled")
        || s.contains("http basic: access denied")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn pid_is_alive(pid: u32) -> bool {
        // `kill -0` sends no signal, just checks the pid exists and is ours
        // to signal — the standard no-op existence probe.
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    /// Regression guard for `kill_on_drop`: a `git clone` against a
    /// listener that accepts the TCP connection but never speaks the
    /// protocol hangs forever unless killed. Dropping the `Child` (what
    /// happens when the owning future is cancelled/dropped) must end it.
    #[tokio::test]
    async fn dropping_the_child_kills_a_hanging_clone() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("local_addr").port();
        std::thread::spawn(move || {
            // Accept and then go silent: `git://` expects the server to
            // speak first, so this stalls the client indefinitely.
            let _ = listener.accept();
            std::thread::sleep(Duration::from_secs(30));
        });

        let cwd = std::env::temp_dir();
        let askpass = cwd.join("theodore-test-unused-askpass.sh");
        let dest = cwd.join(format!("theodore-kill-on-drop-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dest);
        let url = format!("git://127.0.0.1:{port}/theodore-test.git");
        let dest_str = dest.to_str().expect("utf8 tmp path").to_string();

        let proc = GitProc {
            cwd: &cwd,
            askpass: &askpass,
            args: &["clone", &url, &dest_str],
            token: None,
            stdin: None,
        };

        let mut cmd = proc.command();
        let child = cmd.spawn().expect("spawn git clone");
        let pid = child.id().expect("pid");
        assert!(pid_is_alive(pid), "git should be running right after spawn");

        drop(child);
        // Give the OS a moment to act on the kill `kill_on_drop` issues.
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert!(
            !pid_is_alive(pid),
            "git clone must not survive the Child being dropped"
        );

        let _ = std::fs::remove_dir_all(&dest);
    }
}
