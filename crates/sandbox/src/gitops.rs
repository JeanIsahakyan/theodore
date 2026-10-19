//! Synchronous git plumbing over the sandbox's bare "remote" repositories:
//! commits are built with a throwaway index (`hash-object`, `update-index`,
//! `write-tree`, `commit-tree`), merges with `merge-tree --write-tree` — no
//! working copy anywhere. Every call ignores the user's own git config so a
//! signing hook or an alias can't change what the sandbox builds.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};

use theodore_domain::Millis;

use crate::error::{SandboxError, SandboxResult};

static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// Author/committer identity of a sandbox commit.
#[derive(Debug, Clone)]
pub struct Ident {
    pub name: String,
    pub email: String,
}

impl Ident {
    pub fn of(login: &str, name: Option<&str>) -> Self {
        Self {
            name: name.unwrap_or(login).to_string(),
            email: email_of(login),
        }
    }
}

pub fn email_of(login: &str) -> String {
    format!("{login}@users.sandbox.invalid")
}

/// Inverse of `email_of`.
pub fn login_of_email(email: &str) -> Option<&str> {
    email.strip_suffix("@users.sandbox.invalid")
}

/// One change applied by `Bare::commit`.
#[derive(Debug, Clone)]
pub enum Change {
    Write { path: String, bytes: Vec<u8> },
    Delete { path: String },
}

#[derive(Debug, Clone)]
pub struct LogEntry {
    pub sha: String,
    pub author_name: String,
    pub author_email: String,
    pub at: Millis,
    pub subject: String,
}

pub enum MergeTree {
    Clean(String),
    Conflicts(Vec<String>),
}

fn base_command(dir: &Path) -> Command {
    let mut cmd = Command::new("git");
    cmd.current_dir(dir)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    cmd
}

struct Out {
    code: i32,
    stdout: Vec<u8>,
    stderr: String,
}

fn exec(
    dir: &Path,
    args: &[&str],
    env: &[(&str, String)],
    stdin: Option<&[u8]>,
) -> SandboxResult<Out> {
    let mut cmd = base_command(dir);
    cmd.args(args);
    for (k, v) in env {
        cmd.env(k, v);
    }
    if stdin.is_some() {
        cmd.stdin(Stdio::piped());
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| SandboxError::Io(dir.to_path_buf(), e))?;
    if let (Some(data), Some(mut pipe)) = (stdin, child.stdin.take()) {
        pipe.write_all(data)
            .map_err(|e| SandboxError::Io(dir.to_path_buf(), e))?;
    }
    let out = child
        .wait_with_output()
        .map_err(|e| SandboxError::Io(dir.to_path_buf(), e))?;
    Ok(Out {
        code: out.status.code().unwrap_or(-1),
        stdout: out.stdout,
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

fn run(
    dir: &Path,
    args: &[&str],
    env: &[(&str, String)],
    stdin: Option<&[u8]>,
) -> SandboxResult<String> {
    let out = exec(dir, args, env, stdin)?;
    if out.code != 0 {
        return Err(SandboxError::Git {
            args: args.join(" "),
            stderr: out.stderr,
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim_end().to_string())
}

fn date_env(ident: &Ident, at: Millis) -> Vec<(&'static str, String)> {
    let date = format!("@{} +0000", at.div_euclid(1000));
    vec![
        ("GIT_AUTHOR_NAME", ident.name.clone()),
        ("GIT_AUTHOR_EMAIL", ident.email.clone()),
        ("GIT_AUTHOR_DATE", date.clone()),
        ("GIT_COMMITTER_NAME", ident.name.clone()),
        ("GIT_COMMITTER_EMAIL", ident.email.clone()),
        ("GIT_COMMITTER_DATE", date),
    ]
}

/// A bare repository the sandbox owns.
#[derive(Debug, Clone)]
pub struct Bare {
    pub dir: PathBuf,
}

impl Bare {
    pub fn open(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    pub fn exists(&self) -> bool {
        self.dir.join("HEAD").exists()
    }

    pub fn init(dir: impl Into<PathBuf>, default_branch: &str) -> SandboxResult<Self> {
        let dir = dir.into();
        std::fs::create_dir_all(&dir).map_err(|e| SandboxError::Io(dir.clone(), e))?;
        let head = format!("--initial-branch={default_branch}");
        run(&dir, &["init", "--bare", "-q", &head], &[], None)?;
        Ok(Self { dir })
    }

    pub fn url(&self) -> String {
        format!("file://{}", self.dir.display())
    }

    fn git(&self, args: &[&str]) -> SandboxResult<String> {
        run(&self.dir, args, &[], None)
    }

    /// Commit sha of `rev`, `None` if it doesn't resolve.
    pub fn rev_parse(&self, rev: &str) -> Option<String> {
        let spec = format!("{rev}^{{commit}}");
        self.git(&["rev-parse", "--verify", "-q", &spec])
            .ok()
            .filter(|s| !s.is_empty())
    }

    pub fn branch_tip(&self, branch: &str) -> Option<String> {
        self.rev_parse(&format!("refs/heads/{branch}"))
    }

    /// Every ref → sha, in one call.
    pub fn refs(&self) -> HashMap<String, String> {
        self.git(&["for-each-ref", "--format=%(objectname) %(refname)"])
            .unwrap_or_default()
            .lines()
            .filter_map(|l| l.split_once(' '))
            .map(|(sha, name)| (name.to_string(), sha.to_string()))
            .collect()
    }

    /// Feeds a `git fast-import` stream (bulk history creation).
    pub fn fast_import(&self, stream: &[u8]) -> SandboxResult<()> {
        run(&self.dir, &["fast-import", "--quiet"], &[], Some(stream)).map(|_| ())
    }

    pub fn update_ref(&self, name: &str, sha: &str) -> SandboxResult<()> {
        self.git(&["update-ref", name, sha]).map(|_| ())
    }

    pub fn set_head(&self, branch: &str) -> SandboxResult<()> {
        let r = format!("refs/heads/{branch}");
        self.git(&["symbolic-ref", "HEAD", &r]).map(|_| ())
    }

    pub fn read_file(&self, rev: &str, path: &str) -> Option<Vec<u8>> {
        let spec = format!("{rev}:{path}");
        let out = exec(&self.dir, &["cat-file", "blob", &spec], &[], None).ok()?;
        (out.code == 0).then_some(out.stdout)
    }

    /// Paths of every file at `rev`.
    pub fn files_at(&self, rev: &str) -> SandboxResult<Vec<String>> {
        let out = self.git(&["ls-tree", "-r", "--name-only", rev])?;
        Ok(out.lines().map(str::to_string).collect())
    }

    /// A new commit on top of `parent` (or a root commit) with `changes`
    /// applied. Doesn't move any ref.
    pub fn commit(
        &self,
        parent: Option<&str>,
        changes: &[Change],
        message: &str,
        author: &Ident,
        at: Millis,
    ) -> SandboxResult<String> {
        let seq = TMP_SEQ.fetch_add(1, Ordering::SeqCst);
        let index = self
            .dir
            .join(format!("sandbox-index-{}-{seq}", std::process::id()));
        let index_env = [("GIT_INDEX_FILE", index.display().to_string())];
        let result = (|| {
            match parent {
                Some(p) => run(&self.dir, &["read-tree", p], &index_env, None)?,
                None => run(&self.dir, &["read-tree", "--empty"], &index_env, None)?,
            };
            // Blobs in one `hash-object --stdin-paths` call, index entries in
            // one `update-index --index-info` call (mode 0 removes an entry,
            // and neither needs a work tree).
            let staged = self
                .dir
                .join(format!("sandbox-blobs-{}-{seq}", std::process::id()));
            let mut paths = String::new();
            let mut writes = Vec::new();
            for (i, change) in changes.iter().enumerate() {
                if let Change::Write { path, bytes } = change {
                    std::fs::create_dir_all(&staged)
                        .map_err(|e| SandboxError::Io(staged.clone(), e))?;
                    let f = staged.join(i.to_string());
                    std::fs::write(&f, bytes).map_err(|e| SandboxError::Io(f.clone(), e))?;
                    paths.push_str(&format!("{}\n", f.display()));
                    writes.push(path);
                }
            }
            let blobs = if writes.is_empty() {
                String::new()
            } else {
                run(
                    &self.dir,
                    &["hash-object", "-w", "--stdin-paths"],
                    &[],
                    Some(paths.as_bytes()),
                )?
            };
            let _ = std::fs::remove_dir_all(&staged);
            let mut blobs = blobs.lines();
            let mut info = String::new();
            for change in changes {
                match change {
                    Change::Write { path, .. } => {
                        let blob = blobs.next().unwrap_or_default();
                        info.push_str(&format!("100644 {blob}\t{path}\n"));
                    }
                    Change::Delete { path } => {
                        info.push_str(&format!("0 {}\t{path}\n", "0".repeat(40)));
                    }
                }
            }
            if !info.is_empty() {
                run(
                    &self.dir,
                    &["update-index", "--index-info"],
                    &index_env,
                    Some(info.as_bytes()),
                )?;
            }
            let tree = run(&self.dir, &["write-tree"], &index_env, None)?;
            self.commit_tree(
                &tree,
                parent.into_iter().collect::<Vec<_>>().as_slice(),
                message,
                author,
                at,
            )
        })();
        let _ = std::fs::remove_file(&index);
        result
    }

    pub fn commit_tree(
        &self,
        tree: &str,
        parents: &[&str],
        message: &str,
        author: &Ident,
        at: Millis,
    ) -> SandboxResult<String> {
        let mut args = vec!["commit-tree", tree];
        for p in parents {
            args.push("-p");
            args.push(p);
        }
        args.push("-m");
        args.push(message);
        run(&self.dir, &args, &date_env(author, at), None)
    }

    /// `git merge-tree --write-tree ours theirs`, optionally with an
    /// explicit merge base (to replay one commit for a rebase merge).
    pub fn merge_tree(
        &self,
        ours: &str,
        theirs: &str,
        merge_base: Option<&str>,
    ) -> SandboxResult<MergeTree> {
        let base_arg = merge_base.map(|b| format!("--merge-base={b}"));
        let mut args = vec!["merge-tree", "--write-tree", "--name-only", "--no-messages"];
        if let Some(b) = &base_arg {
            args.push(b);
        }
        args.push(ours);
        args.push(theirs);
        let out = exec(&self.dir, &args, &[], None)?;
        let text = String::from_utf8_lossy(&out.stdout).into_owned();
        let mut lines = text.lines();
        let tree = lines.next().unwrap_or_default().trim().to_string();
        match out.code {
            0 => Ok(MergeTree::Clean(tree)),
            1 => Ok(MergeTree::Conflicts(
                lines
                    .map(str::trim)
                    .filter(|l| !l.is_empty())
                    .map(str::to_string)
                    .collect(),
            )),
            _ => Err(SandboxError::Git {
                args: args.join(" "),
                stderr: out.stderr,
            }),
        }
    }

    /// Commits in `base..head`, oldest first.
    pub fn log(&self, base: &str, head: &str) -> SandboxResult<Vec<LogEntry>> {
        let range = format!("{base}..{head}");
        let out = self.git(&[
            "log",
            "--reverse",
            "--format=%H%x1f%an%x1f%ae%x1f%at%x1f%s",
            &range,
        ])?;
        Ok(out
            .lines()
            .filter_map(|l| {
                let mut p = l.split('\u{1f}');
                Some(LogEntry {
                    sha: p.next()?.to_string(),
                    author_name: p.next()?.to_string(),
                    author_email: p.next()?.to_string(),
                    at: p.next()?.parse::<i64>().ok()? * 1000,
                    subject: p.next().unwrap_or_default().to_string(),
                })
            })
            .collect())
    }

    /// (additions, deletions, files) of `base...head`.
    pub fn numstat(&self, base: &str, head: &str) -> SandboxResult<(u32, u32, u32)> {
        let range = format!("{base}...{head}");
        let out = self.git(&["diff", "--numstat", "--find-renames", &range])?;
        let (mut a, mut d, mut f) = (0u32, 0u32, 0u32);
        for line in out.lines() {
            let mut p = line.split('\t');
            a += p.next().and_then(|x| x.parse().ok()).unwrap_or(0);
            d += p.next().and_then(|x| x.parse().ok()).unwrap_or(0);
            f += 1;
        }
        Ok((a, d, f))
    }

    /// Paths changed between two commits (two-dot), and in `base...head`
    /// when `three_dot`.
    pub fn changed_paths(&self, a: &str, b: &str, three_dot: bool) -> SandboxResult<Vec<String>> {
        let range = if three_dot {
            format!("{a}...{b}")
        } else {
            format!("{a}..{b}")
        };
        let out = self.git(&["diff", "--name-only", "--no-renames", &range])?;
        Ok(out.lines().map(str::to_string).collect())
    }

    /// Unified diff of one path between two commits (`-U0`).
    pub fn diff_path(&self, a: &str, b: &str, path: &str) -> SandboxResult<String> {
        self.git(&["diff", "-U0", "--no-color", a, b, "--", path])
    }

    pub fn is_ancestor(&self, ancestor: &str, of: &str) -> bool {
        exec(
            &self.dir,
            &["merge-base", "--is-ancestor", ancestor, of],
            &[],
            None,
        )
        .map(|o| o.code == 0)
        .unwrap_or(false)
    }

    pub fn merge_base(&self, a: &str, b: &str) -> Option<String> {
        self.git(&["merge-base", a, b])
            .ok()
            .filter(|s| !s.is_empty())
    }

    pub fn tree_of(&self, rev: &str) -> SandboxResult<String> {
        let spec = format!("{rev}^{{tree}}");
        self.git(&["rev-parse", &spec])
    }

    pub fn parent_of(&self, rev: &str) -> Option<String> {
        self.rev_parse(&format!("{rev}^"))
    }
}

/// `git clone` into a working copy (local folder projects).
pub fn clone_working(from: &Bare, to: &Path) -> SandboxResult<()> {
    let parent = to.parent().unwrap_or(to);
    std::fs::create_dir_all(parent).map_err(|e| SandboxError::Io(parent.to_path_buf(), e))?;
    let src = from.dir.display().to_string();
    let dst = to.display().to_string();
    run(parent, &["clone", "-q", &src, &dst], &[], None)?;
    let branches = run(
        to,
        &[
            "for-each-ref",
            "--format=%(refname:short)",
            "refs/remotes/origin",
        ],
        &[],
        None,
    )?;
    let current = run(to, &["branch", "--show-current"], &[], None)?;
    for b in branches.lines() {
        let Some(name) = b.strip_prefix("origin/") else {
            continue;
        };
        if name == "HEAD" || name == current {
            continue;
        }
        run(to, &["branch", "-q", name, b], &[], None)?;
    }
    run(to, &["remote", "remove", "origin"], &[], None)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn me() -> Ident {
        Ident::of("you", Some("You"))
    }

    #[test]
    fn commits_merges_and_logs_without_a_working_copy() {
        let tmp = tempfile::tempdir().unwrap();
        let bare = Bare::init(tmp.path().join("r.git"), "main").unwrap();
        let c1 = bare
            .commit(
                None,
                &[Change::Write {
                    path: "a/b.txt".into(),
                    bytes: b"one\n".to_vec(),
                }],
                "base",
                &me(),
                1_700_000_000_000,
            )
            .unwrap();
        bare.update_ref("refs/heads/main", &c1).unwrap();
        let c2 = bare
            .commit(
                Some(&c1),
                &[
                    Change::Write {
                        path: "a/b.txt".into(),
                        bytes: b"one\ntwo\n".to_vec(),
                    },
                    Change::Write {
                        path: "img.png".into(),
                        bytes: vec![0x89, b'P', b'N', b'G', 0, 1, 2],
                    },
                ],
                "feature",
                &me(),
                1_700_000_100_000,
            )
            .unwrap();
        assert_eq!(bare.read_file(&c2, "a/b.txt").unwrap(), b"one\ntwo\n");
        assert_eq!(bare.read_file(&c1, "img.png"), None);
        let log = bare.log(&c1, &c2).unwrap();
        assert_eq!(log.len(), 1);
        assert_eq!(log[0].subject, "feature");
        assert_eq!(login_of_email(&log[0].author_email), Some("you"));
        assert_eq!(log[0].at, 1_700_000_100_000);
        let (adds, _dels, files) = bare.numstat(&c1, &c2).unwrap();
        assert_eq!((adds, files), (1, 2));

        // A diverging edit of the same line conflicts.
        let c3 = bare
            .commit(
                Some(&c1),
                &[Change::Write {
                    path: "a/b.txt".into(),
                    bytes: b"uno\n".to_vec(),
                }],
                "conflict",
                &me(),
                1_700_000_200_000,
            )
            .unwrap();
        match bare.merge_tree(&c2, &c3, None).unwrap() {
            MergeTree::Conflicts(paths) => assert_eq!(paths, vec!["a/b.txt".to_string()]),
            MergeTree::Clean(_) => panic!("expected a conflict"),
        }
        let deleted = bare
            .commit(
                Some(&c2),
                &[Change::Delete {
                    path: "img.png".into(),
                }],
                "drop",
                &me(),
                1_700_000_300_000,
            )
            .unwrap();
        assert!(matches!(
            bare.merge_tree(&c2, &deleted, None).unwrap(),
            MergeTree::Clean(_)
        ));
        assert!(bare.is_ancestor(&c1, &c2));
        assert!(!bare.is_ancestor(&c3, &c2));
    }
}
