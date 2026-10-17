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
    pub(crate) async fn run(&self) -> GitResult<Vec<u8>> {
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
            .stderr(Stdio::piped());
        match self.token {
            Some(t) => {
                cmd.env("THEODORE_GIT_TOKEN", t);
                cmd.env("THEODORE_GIT_USER", "x-access-token");
            }
            None => {
                cmd.env_remove("THEODORE_GIT_TOKEN");
            }
        }

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
