//! Parses `git diff --no-color --no-ext-diff -U<n> <base>...<head>` output
//! (plus a `--numstat -z` pass for ground-truth counts) into domain
//! [`FileDiff`]/[`Hunk`] values. Pure: no I/O, so every shape below is a
//! fixture-driven unit test rather than an integration test.

use theodore_domain::interdiff::hunk_id;
use theodore_domain::{DiffLine, FileDiff, FileFlag, FileStatus, Hunk, LineKind};

use crate::generated::{self, GitAttributes};

/// One `--numstat -z` record. `additions`/`deletions` are `None` for binary
/// files (git reports `-` for both).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NumstatEntry {
    pub additions: Option<u32>,
    pub deletions: Option<u32>,
    pub old_path: Option<String>,
    pub path: String,
}

/// Parses `git diff --numstat -z` output. With `-z`, a renamed/copied file's
/// record has an empty path field followed by two NUL-terminated paths
/// (old, new) instead of one.
pub(crate) fn parse_numstat(bytes: &[u8]) -> Vec<NumstatEntry> {
    let text = String::from_utf8_lossy(bytes);
    let mut tokens = text.split('\0');
    let mut out = Vec::new();
    while let Some(tok) = tokens.next() {
        if tok.is_empty() {
            continue; // trailing split artifact
        }
        let mut parts = tok.splitn(3, '\t');
        let add = parts.next().unwrap_or("");
        let del = parts.next().unwrap_or("");
        let rest = parts.next().unwrap_or("");
        let additions = if add == "-" { None } else { add.parse().ok() };
        let deletions = if del == "-" { None } else { del.parse().ok() };
        if rest.is_empty() {
            let old_path = tokens.next().unwrap_or_default().to_string();
            let path = tokens.next().unwrap_or_default().to_string();
            out.push(NumstatEntry {
                additions,
                deletions,
                old_path: Some(old_path),
                path,
            });
        } else {
            out.push(NumstatEntry {
                additions,
                deletions,
                old_path: None,
                path: rest.to_string(),
            });
        }
    }
    out
}

/// A parsed file plus the blob shas from its `index` line, so the caller can
/// batch-resolve binary file sizes with `git cat-file --batch-check`.
#[derive(Debug, Clone)]
pub(crate) struct ParsedFile {
    pub file: FileDiff,
    pub old_sha: Option<String>,
    pub new_sha: Option<String>,
}

/// Parses the full unified-diff text into one [`FileDiff`] per file block.
/// `numstat` supplies ground-truth additions/deletions (and catches binary
/// files, which carry no line counts in the unified text) and decides the
/// oversize cutoff before hunks are materialized.
pub(crate) fn parse_unified_diff(
    text: &str,
    numstat: &[NumstatEntry],
    attrs: &GitAttributes,
    max_file_lines: u32,
) -> Vec<ParsedFile> {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        if !lines[i].starts_with("diff --git ") {
            i += 1;
            continue;
        }
        let git_line = lines[i];
        i += 1;

        let mut rename_from = None;
        let mut rename_to = None;
        let mut copy_from = None;
        let mut copy_to = None;
        let mut old_mode = None;
        let mut new_mode = None;
        let mut new_file = false;
        let mut deleted_file = false;
        let mut old_sha = None;
        let mut new_sha = None;
        let mut similarity = None;
        let mut binary = false;
        let mut minus_path = None;
        let mut plus_path = None;

        while i < lines.len()
            && !lines[i].starts_with("diff --git ")
            && !lines[i].starts_with("@@ ")
        {
            let l = lines[i];
            if let Some(v) = l.strip_prefix("old mode ") {
                old_mode = Some(v.trim().to_string());
            } else if let Some(v) = l.strip_prefix("new mode ") {
                new_mode = Some(v.trim().to_string());
            } else if let Some(v) = l.strip_prefix("deleted file mode ") {
                deleted_file = true;
                old_mode = Some(v.trim().to_string());
            } else if let Some(v) = l.strip_prefix("new file mode ") {
                new_file = true;
                new_mode = Some(v.trim().to_string());
            } else if let Some(v) = l.strip_prefix("similarity index ") {
                similarity = v.trim().trim_end_matches('%').parse::<u8>().ok();
            } else if let Some(v) = l.strip_prefix("rename from ") {
                rename_from = Some(unquote_path(v));
            } else if let Some(v) = l.strip_prefix("rename to ") {
                rename_to = Some(unquote_path(v));
            } else if let Some(v) = l.strip_prefix("copy from ") {
                copy_from = Some(unquote_path(v));
            } else if let Some(v) = l.strip_prefix("copy to ") {
                copy_to = Some(unquote_path(v));
            } else if let Some(v) = l.strip_prefix("index ") {
                let head = v.split(' ').next().unwrap_or(v);
                if let Some((a, b)) = head.split_once("..") {
                    old_sha = Some(a.to_string());
                    new_sha = Some(b.to_string());
                }
            } else if l.starts_with("Binary files ") || l.starts_with("GIT binary patch") {
                binary = true;
            } else if let Some(v) = l.strip_prefix("--- ") {
                minus_path = path_from_marker(v, "a/");
            } else if let Some(v) = l.strip_prefix("+++ ") {
                plus_path = path_from_marker(v, "b/");
            }
            i += 1;
        }

        let status = if rename_to.is_some() {
            FileStatus::Renamed
        } else if copy_to.is_some() {
            FileStatus::Copied
        } else if new_file {
            FileStatus::Added
        } else if deleted_file {
            FileStatus::Deleted
        } else {
            FileStatus::Modified
        };

        let (path, old_path) = match status {
            FileStatus::Renamed => (rename_to.clone().unwrap(), rename_from.clone()),
            FileStatus::Copied => (copy_to.clone().unwrap(), copy_from.clone()),
            _ => {
                let p = plus_path
                    .clone()
                    .or_else(|| minus_path.clone())
                    .unwrap_or_else(|| {
                        let (_, b) = fallback_paths_from_git_line(git_line);
                        b
                    });
                (p, None)
            }
        };

        // Hunks.
        let mut hunks: Vec<Hunk> = Vec::new();
        let mut additions = 0u32;
        let mut deletions = 0u32;
        while i < lines.len() && lines[i].starts_with("@@ ") {
            let (old_start, old_lines, new_start, new_lines, header) = parse_hunk_header(lines[i]);
            i += 1;
            let mut hunk_lines = Vec::new();
            let mut old_no = old_start;
            let mut new_no = new_start;
            while i < lines.len() {
                let l = lines[i];
                if l.starts_with("@@ ") || l.starts_with("diff --git ") {
                    break;
                }
                if l == "\\ No newline at end of file" {
                    i += 1;
                    continue;
                }
                let (kind, content) = match l.as_bytes().first() {
                    Some(b'+') => (LineKind::Add, &l[1..]),
                    Some(b'-') => (LineKind::Del, &l[1..]),
                    Some(b' ') => (LineKind::Ctx, &l[1..]),
                    // Every real diff line has at least a 1-char prefix; an
                    // empty line is only the trailing artifact of splitting
                    // text that ends with `\n` — skip it, don't fabricate a
                    // blank context line.
                    None => {
                        i += 1;
                        continue;
                    }
                    _ => {
                        // Defensive: an unexpected line shape (shouldn't happen
                        // for `--no-color --no-ext-diff` output); skip it
                        // rather than mis-parse it as a hunk line.
                        i += 1;
                        continue;
                    }
                };
                let (old_n, new_n) = match kind {
                    LineKind::Add => {
                        let n = new_no;
                        new_no += 1;
                        (None, Some(n))
                    }
                    LineKind::Del => {
                        let n = old_no;
                        old_no += 1;
                        (Some(n), None)
                    }
                    LineKind::Ctx => {
                        let o = old_no;
                        let n = new_no;
                        old_no += 1;
                        new_no += 1;
                        (Some(o), Some(n))
                    }
                };
                match kind {
                    LineKind::Add => additions += 1,
                    LineKind::Del => deletions += 1,
                    LineKind::Ctx => {}
                }
                hunk_lines.push(DiffLine {
                    kind,
                    text: content.to_string(),
                    old_no: old_n,
                    new_no: new_n,
                });
                i += 1;
            }
            let id = hunk_id(&path, &hunk_lines);
            hunks.push(Hunk {
                id,
                path: path.clone(),
                old_start,
                old_lines,
                new_start,
                new_lines,
                header,
                lines: hunk_lines,
            });
        }

        let numstat_entry = numstat.iter().find(|n| {
            n.path == path
                && match status {
                    FileStatus::Renamed | FileStatus::Copied => {
                        n.old_path.as_deref() == old_path.as_deref()
                    }
                    _ => true,
                }
        });
        let final_additions = numstat_entry.and_then(|n| n.additions).unwrap_or(additions);
        let final_deletions = numstat_entry.and_then(|n| n.deletions).unwrap_or(deletions);
        let changed_lines = numstat_entry
            .and_then(|n| match (n.additions, n.deletions) {
                (Some(a), Some(d)) => Some(a + d),
                _ => None,
            })
            .unwrap_or(additions + deletions);

        let mut flags = Vec::new();
        let is_submodule =
            old_mode.as_deref() == Some("160000") || new_mode.as_deref() == Some("160000");
        if is_submodule {
            flags.push(FileFlag::Submodule);
        }
        if binary {
            flags.push(FileFlag::Binary {
                old_size: None,
                new_size: None,
            });
        }
        if generated::is_lfs(attrs, &path) {
            flags.push(FileFlag::Lfs);
        }
        if let Some(reason) = generated::generated_by_name(&path)
            .or_else(|| generated::generated_by_attr(attrs, &path))
        {
            flags.push(FileFlag::Generated { reason });
        }
        let oversize = changed_lines > max_file_lines;
        if oversize {
            flags.push(FileFlag::Oversize {
                lines: changed_lines,
            });
        }

        let file = FileDiff {
            path,
            old_path,
            status,
            similarity,
            old_mode,
            new_mode,
            flags,
            additions: final_additions,
            deletions: final_deletions,
            hunks: if oversize { Vec::new() } else { hunks },
        };
        out.push(ParsedFile {
            file,
            old_sha,
            new_sha,
        });
    }
    out
}

fn parse_hunk_header(line: &str) -> (u32, u32, u32, u32, String) {
    let rest = line.strip_prefix("@@ ").unwrap_or(line);
    let end = rest.find(" @@").unwrap_or(rest.len());
    let ranges = &rest[..end];
    let header = rest[end..]
        .trim_start_matches(" @@")
        .trim_start()
        .to_string();
    let mut parts = ranges.split_whitespace();
    let old = parts.next().unwrap_or("-0,0");
    let new = parts.next().unwrap_or("+0,0");
    let (old_start, old_lines) = parse_range(old, '-');
    let (new_start, new_lines) = parse_range(new, '+');
    (old_start, old_lines, new_start, new_lines, header)
}

fn parse_range(s: &str, sign: char) -> (u32, u32) {
    let s = s.strip_prefix(sign).unwrap_or(s);
    match s.split_once(',') {
        Some((a, b)) => (a.parse().unwrap_or(0), b.parse().unwrap_or(0)),
        None => (s.parse().unwrap_or(0), 1),
    }
}

/// Best-effort split of a `diff --git a/<old> b/<new>` line. Only needed as
/// a fallback for pure mode-change blocks, which have no `---`/`+++` lines;
/// ambiguous if a path itself contains the literal `" b/"`, which real paths
/// essentially never do.
fn fallback_paths_from_git_line(line: &str) -> (String, String) {
    let rest = line.strip_prefix("diff --git a/").unwrap_or(line);
    match rest.rfind(" b/") {
        Some(idx) => (rest[..idx].to_string(), rest[idx + 3..].to_string()),
        None => (rest.to_string(), rest.to_string()),
    }
}

fn path_from_marker(v: &str, prefix: &str) -> Option<String> {
    if v == "/dev/null" {
        return None;
    }
    let stripped = v.strip_prefix(prefix).unwrap_or(v);
    Some(unquote_path(stripped))
}

/// Git quotes a path in double quotes with C-style escapes when it contains
/// unusual bytes (default `core.quotepath=true`). Handles the common escapes;
/// not a full C-string unescaper.
fn unquote_path(s: &str) -> String {
    let s = s.trim();
    if s.len() >= 2 && s.starts_with('"') && s.ends_with('"') {
        unescape_c(&s[1..s.len() - 1])
    } else {
        s.to_string()
    }
}

fn unescape_c(s: &str) -> String {
    let mut out = String::new();
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('"') => out.push('"'),
            Some('\\') => out.push('\\'),
            Some(d) if d.is_ascii_digit() => {
                let mut oct = String::from(d);
                for _ in 0..2 {
                    match chars.peek() {
                        Some(&n) if n.is_ascii_digit() => {
                            oct.push(n);
                            chars.next();
                        }
                        _ => break,
                    }
                }
                if let Ok(byte) = u8::from_str_radix(&oct, 8) {
                    out.push(byte as char);
                }
            }
            Some(other) => out.push(other),
            None => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    fn attrs() -> GitAttributes {
        GitAttributes::parse("")
    }

    #[test]
    fn simple_modification() {
        // Deliberately not using `\`-continued lines here: a backslash right
        // before a newline makes rustc eat all leading whitespace on the
        // next line too, which would silently swallow the significant
        // leading space on a context line (` line1`). Plain embedded
        // newlines keep every byte as written.
        let diff = "diff --git a/a.txt b/a.txt
index 83db48f..6b027f2 100644
--- a/a.txt
+++ b/a.txt
@@ -1,3 +1,4 @@
 line1
-line2
+line2 CHANGED
 line3
+line4
";
        let numstat = vec![NumstatEntry {
            additions: Some(2),
            deletions: Some(1),
            old_path: None,
            path: "a.txt".into(),
        }];
        let parsed = parse_unified_diff(diff, &numstat, &attrs(), 5_000);
        assert_eq!(parsed.len(), 1);
        let f = &parsed[0].file;
        assert_eq!(f.path, "a.txt");
        assert_eq!(f.status, FileStatus::Modified);
        assert_eq!(f.additions, 2);
        assert_eq!(f.deletions, 1);
        assert_eq!(f.hunks.len(), 1);
        let h = &f.hunks[0];
        assert_eq!(
            (h.old_start, h.old_lines, h.new_start, h.new_lines),
            (1, 3, 1, 4)
        );
        assert_eq!(h.lines.len(), 5);
        assert_eq!(h.lines[0].kind, LineKind::Ctx);
        assert_eq!(h.lines[0].old_no, Some(1));
        assert_eq!(h.lines[0].new_no, Some(1));
        assert_eq!(h.lines[1].kind, LineKind::Del);
        assert_eq!(h.lines[1].old_no, Some(2));
        assert_eq!(h.lines[1].new_no, None);
        assert_eq!(h.lines[2].kind, LineKind::Add);
        assert_eq!(h.lines[2].text, "line2 CHANGED");
        assert_eq!(h.lines[2].old_no, None);
        assert_eq!(h.lines[2].new_no, Some(2));
        assert_eq!(h.lines[4].kind, LineKind::Add);
        assert_eq!(h.lines[4].old_no, None);
        assert_eq!(h.lines[4].new_no, Some(4));
    }

    #[test]
    fn binary_file_flagged_without_hunks() {
        let diff = "diff --git a/blob.bin b/blob.bin\n\
new file mode 100644\n\
index 0000000..707e7c8\n\
Binary files /dev/null and b/blob.bin differ\n";
        let numstat = vec![NumstatEntry {
            additions: None,
            deletions: None,
            old_path: None,
            path: "blob.bin".into(),
        }];
        let parsed = parse_unified_diff(diff, &numstat, &attrs(), 5_000);
        let f = &parsed[0].file;
        assert_eq!(f.status, FileStatus::Added);
        assert_eq!(f.hunks.len(), 0);
        assert_eq!(f.additions, 0);
        assert_eq!(f.deletions, 0);
        assert!(
            f.flags
                .iter()
                .any(|fl| matches!(fl, FileFlag::Binary { .. }))
        );
        assert_eq!(parsed[0].old_sha.as_deref(), Some("0000000"));
        assert_eq!(parsed[0].new_sha.as_deref(), Some("707e7c8"));
    }

    #[test]
    fn rename_with_content_change_and_similarity() {
        let diff = "diff --git a/keep.txt b/moved.txt
similarity index 50%
rename from keep.txt
rename to moved.txt
index ce01362..94954ab 100644
--- a/keep.txt
+++ b/moved.txt
@@ -1 +1,2 @@
 hello
+world
";
        let numstat = vec![NumstatEntry {
            additions: Some(1),
            deletions: Some(0),
            old_path: Some("keep.txt".into()),
            path: "moved.txt".into(),
        }];
        let parsed = parse_unified_diff(diff, &numstat, &attrs(), 5_000);
        let f = &parsed[0].file;
        assert_eq!(f.status, FileStatus::Renamed);
        assert_eq!(f.path, "moved.txt");
        assert_eq!(f.old_path.as_deref(), Some("keep.txt"));
        assert_eq!(f.similarity, Some(50));
        assert_eq!(f.additions, 1);
        assert_eq!(f.hunks.len(), 1);
        assert_eq!(f.hunks[0].lines.len(), 2);
        assert_eq!(f.hunks[0].lines[0].kind, LineKind::Ctx);
        assert_eq!(f.hunks[0].lines[0].text, "hello");
        assert_eq!(f.hunks[0].lines[1].kind, LineKind::Add);
        assert_eq!(f.hunks[0].lines[1].text, "world");
    }

    #[test]
    fn copy_with_no_content_change_has_no_hunks() {
        let diff = "diff --git a/a.txt b/a_copy.txt\n\
similarity index 100%\n\
copy from a.txt\n\
copy to a_copy.txt\n";
        let numstat = vec![NumstatEntry {
            additions: Some(0),
            deletions: Some(0),
            old_path: Some("a.txt".into()),
            path: "a_copy.txt".into(),
        }];
        let parsed = parse_unified_diff(diff, &numstat, &attrs(), 5_000);
        let f = &parsed[0].file;
        assert_eq!(f.status, FileStatus::Copied);
        assert_eq!(f.old_path.as_deref(), Some("a.txt"));
        assert_eq!(f.similarity, Some(100));
        assert_eq!(f.hunks.len(), 0);
    }

    #[test]
    fn pure_mode_change_has_no_hunks_and_uses_fallback_path() {
        let diff = "diff --git a/a.txt b/a.txt\nold mode 100644\nnew mode 100755\n";
        let numstat = vec![];
        let parsed = parse_unified_diff(diff, &numstat, &attrs(), 5_000);
        let f = &parsed[0].file;
        assert_eq!(f.path, "a.txt");
        assert_eq!(f.status, FileStatus::Modified);
        assert_eq!(f.old_mode.as_deref(), Some("100644"));
        assert_eq!(f.new_mode.as_deref(), Some("100755"));
        assert_eq!(f.hunks.len(), 0);
    }

    #[test]
    fn deleted_file_keeps_old_path_as_path() {
        let diff = "diff --git a/nonewline.txt b/nonewline.txt\n\
deleted file mode 100644\n\
index 2802503..0000000\n\
--- a/nonewline.txt\n\
+++ /dev/null\n\
@@ -1 +0,0 @@\n\
-no newline at end\n\
\\ No newline at end of file\n";
        let numstat = vec![NumstatEntry {
            additions: Some(0),
            deletions: Some(1),
            old_path: None,
            path: "nonewline.txt".into(),
        }];
        let parsed = parse_unified_diff(diff, &numstat, &attrs(), 5_000);
        let f = &parsed[0].file;
        assert_eq!(f.status, FileStatus::Deleted);
        assert_eq!(f.path, "nonewline.txt");
        assert_eq!(f.old_path, None);
        assert_eq!(f.hunks[0].lines.len(), 1);
        assert_eq!(f.hunks[0].lines[0].kind, LineKind::Del);
        assert_eq!(f.hunks[0].lines[0].text, "no newline at end");
    }

    #[test]
    fn submodule_pointer_bump_flagged() {
        let diff = "diff --git a/libs/sub b/libs/sub\n\
new file mode 160000\n\
index 0000000..3916af4\n\
--- /dev/null\n\
+++ b/libs/sub\n\
@@ -0,0 +1 @@\n\
+Subproject commit 3916af410cccff5ebaf39541c8d7ededf2873aef\n";
        let numstat = vec![NumstatEntry {
            additions: Some(1),
            deletions: Some(0),
            old_path: None,
            path: "libs/sub".into(),
        }];
        let parsed = parse_unified_diff(diff, &numstat, &attrs(), 5_000);
        let f = &parsed[0].file;
        assert!(f.flags.contains(&FileFlag::Submodule));
    }

    #[test]
    fn lockfile_flagged_generated() {
        let diff = "diff --git a/Cargo.lock b/Cargo.lock\n\
index 111..222 100644\n\
--- a/Cargo.lock\n\
+++ b/Cargo.lock\n\
@@ -1 +1 @@\n\
-a\n\
+b\n";
        let numstat = vec![NumstatEntry {
            additions: Some(1),
            deletions: Some(1),
            old_path: None,
            path: "Cargo.lock".into(),
        }];
        let parsed = parse_unified_diff(diff, &numstat, &attrs(), 5_000);
        let f = &parsed[0].file;
        assert!(f.flags.iter().any(
            |fl| matches!(fl, FileFlag::Generated { reason } if reason.contains("Cargo.lock"))
        ));
    }

    #[test]
    fn linguist_generated_attribute_flags_file() {
        let diff = "diff --git a/models.pb.go b/models.pb.go\n\
index 111..222 100644\n\
--- a/models.pb.go\n\
+++ b/models.pb.go\n\
@@ -1 +1 @@\n\
-a\n\
+b\n";
        let numstat = vec![NumstatEntry {
            additions: Some(1),
            deletions: Some(1),
            old_path: None,
            path: "models.pb.go".into(),
        }];
        let attrs = GitAttributes::parse("*.pb.go linguist-generated\n");
        let parsed = parse_unified_diff(diff, &numstat, &attrs, 5_000);
        let f = &parsed[0].file;
        assert!(
            f.flags
                .iter()
                .any(|fl| matches!(fl, FileFlag::Generated { .. }))
        );
    }

    #[test]
    fn lfs_pointer_file_flagged() {
        let diff = "diff --git a/art/cover.psd b/art/cover.psd
index 111..222 100644
--- a/art/cover.psd
+++ b/art/cover.psd
@@ -1,3 +1,3 @@
 version https://git-lfs.github.com/spec/v1
-oid sha256:aaa
+oid sha256:bbb
 size 10
";
        let numstat = vec![NumstatEntry {
            additions: Some(1),
            deletions: Some(1),
            old_path: None,
            path: "art/cover.psd".into(),
        }];
        let attrs = GitAttributes::parse("*.psd filter=lfs diff=lfs merge=lfs -text\n");
        let parsed = parse_unified_diff(diff, &numstat, &attrs, 5_000);
        let f = &parsed[0].file;
        assert!(f.flags.contains(&FileFlag::Lfs));
        // ctx, del, add, ctx: a 1-line change still shows as separate del+add lines.
        assert_eq!(f.hunks[0].lines.len(), 4);
        assert_eq!(
            f.hunks[0].lines[0].text,
            "version https://git-lfs.github.com/spec/v1"
        );
        assert_eq!(f.hunks[0].lines[3].text, "size 10");
    }

    #[test]
    fn oversize_file_drops_hunks_but_keeps_counts() {
        let diff = "diff --git a/big.txt b/big.txt\n\
index 111..222 100644\n\
--- a/big.txt\n\
+++ b/big.txt\n\
@@ -1,2 +1,2 @@\n\
-a\n\
-b\n\
+c\n\
+d\n";
        let numstat = vec![NumstatEntry {
            additions: Some(6000),
            deletions: Some(6000),
            old_path: None,
            path: "big.txt".into(),
        }];
        let parsed = parse_unified_diff(diff, &numstat, &attrs(), 5_000);
        let f = &parsed[0].file;
        assert_eq!(f.hunks.len(), 0);
        assert_eq!(f.additions, 6000);
        assert_eq!(f.deletions, 6000);
        assert!(
            f.flags
                .iter()
                .any(|fl| matches!(fl, FileFlag::Oversize { lines } if *lines == 12_000))
        );
    }

    #[test]
    fn multiple_files_in_one_diff() {
        let diff = "diff --git a/a.txt b/a.txt\n\
index 1..2 100644\n\
--- a/a.txt\n\
+++ b/a.txt\n\
@@ -1 +1 @@\n\
-a\n\
+b\n\
diff --git a/c.txt b/c.txt\n\
new file mode 100644\n\
index 0000000..3\n\
--- /dev/null\n\
+++ b/c.txt\n\
@@ -0,0 +1 @@\n\
+new\n";
        let numstat = vec![
            NumstatEntry {
                additions: Some(1),
                deletions: Some(1),
                old_path: None,
                path: "a.txt".into(),
            },
            NumstatEntry {
                additions: Some(1),
                deletions: Some(0),
                old_path: None,
                path: "c.txt".into(),
            },
        ];
        let parsed = parse_unified_diff(diff, &numstat, &attrs(), 5_000);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].file.path, "a.txt");
        assert_eq!(parsed[1].file.path, "c.txt");
        assert_eq!(parsed[1].file.status, FileStatus::Added);
    }

    #[test]
    fn numstat_rename_record_parses_two_paths() {
        // "1\t0\t\0keep.txt\0moved.txt\0" — empirically confirmed git format.
        let bytes = b"1\t0\t\0keep.txt\0moved.txt\0";
        let entries = parse_numstat(bytes);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].old_path.as_deref(), Some("keep.txt"));
        assert_eq!(entries[0].path, "moved.txt");
        assert_eq!(entries[0].additions, Some(1));
        assert_eq!(entries[0].deletions, Some(0));
    }

    #[test]
    fn numstat_binary_record_has_no_counts() {
        let bytes = b"-\t-\tblob.bin\0";
        let entries = parse_numstat(bytes);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].additions, None);
        assert_eq!(entries[0].deletions, None);
        assert_eq!(entries[0].path, "blob.bin");
    }

    #[test]
    fn hunk_ids_are_stable_across_context_shift() {
        let diff_a = "diff --git a/a.txt b/a.txt\nindex 1..2 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -5,3 +5,3 @@\n ctx1\n-old\n+new\n ctx2\n";
        let diff_b = "diff --git a/a.txt b/a.txt\nindex 1..2 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -50,3 +50,3 @@\n ctx1\n-old\n+new\n ctx2\n";
        let numstat = vec![NumstatEntry {
            additions: Some(1),
            deletions: Some(1),
            old_path: None,
            path: "a.txt".into(),
        }];
        let a = parse_unified_diff(diff_a, &numstat, &attrs(), 5_000);
        let b = parse_unified_diff(diff_b, &numstat, &attrs(), 5_000);
        assert_eq!(a[0].file.hunks[0].id, b[0].file.hunks[0].id);
    }
}
