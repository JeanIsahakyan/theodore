//! Parses a unified diff (`git diff` / `.patch`, e.g. `git diff --no-color
//! --find-renames -U3 base...head`) into a `theodore_domain::Revision`, for
//! `theodore group --diff-file`. This is a CLI-local stand-in for the real
//! `GitPort::diff` (the `git` crate, built by a parallel slice) — just
//! enough unified-diff parsing to drive the grouping pipeline from a file.

use std::sync::OnceLock;

use anyhow::{Context, Result, bail};
use theodore_domain::interdiff::hunk_id;
use theodore_domain::{DiffLine, FileDiff, FileFlag, FileStatus, Hunk, LineKind, Revision, Sha};

fn diff_git_re() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r#"^diff --git a/(.+) b/(.+)$"#).unwrap())
}

fn hunk_header_re() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(r#"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@[ \t]?(.*)$"#).unwrap()
    })
}

struct InProgressFile {
    path: String,
    old_path: Option<String>,
    status: FileStatus,
    similarity: Option<u8>,
    old_mode: Option<String>,
    new_mode: Option<String>,
    flags: Vec<FileFlag>,
    hunks: Vec<Hunk>,
}

impl InProgressFile {
    fn new(old: &str, new: &str) -> Self {
        Self {
            path: new.to_string(),
            old_path: if old == new {
                None
            } else {
                Some(old.to_string())
            },
            status: FileStatus::Modified,
            similarity: None,
            old_mode: None,
            new_mode: None,
            flags: vec![],
            hunks: vec![],
        }
    }

    fn finish(self) -> FileDiff {
        let additions = self
            .hunks
            .iter()
            .flat_map(|h| &h.lines)
            .filter(|l| l.kind == LineKind::Add)
            .count() as u32;
        let deletions = self
            .hunks
            .iter()
            .flat_map(|h| &h.lines)
            .filter(|l| l.kind == LineKind::Del)
            .count() as u32;
        FileDiff {
            path: self.path,
            old_path: self.old_path,
            status: self.status,
            similarity: self.similarity,
            old_mode: self.old_mode,
            new_mode: self.new_mode,
            flags: self.flags,
            additions,
            deletions,
            hunks: self.hunks,
        }
    }
}

/// Parse unified diff `text` into a `Revision`. `base`/`head` are whatever
/// labels the caller wants recorded — a raw patch carries no shas of its own.
pub fn parse(text: &str, base: &str, head: &str) -> Result<Revision> {
    let mut files = Vec::new();
    let mut current: Option<InProgressFile> = None;
    let mut current_hunk: Option<(u32, u32, String, Vec<DiffLine>)> = None; // (old_no, new_no, header, lines)

    let flush_hunk = |current: &mut Option<InProgressFile>,
                      hunk: Option<(u32, u32, String, Vec<DiffLine>)>,
                      old_start: u32,
                      new_start: u32| {
        if let Some((_, _, header, lines)) = hunk
            && let Some(f) = current.as_mut()
        {
            let id = hunk_id(&f.path, &lines);
            let old_lines = lines.iter().filter(|l| l.kind != LineKind::Add).count() as u32;
            let new_lines = lines.iter().filter(|l| l.kind != LineKind::Del).count() as u32;
            f.hunks.push(Hunk {
                id,
                path: f.path.clone(),
                old_start,
                old_lines,
                new_start,
                new_lines,
                header,
                lines,
            });
        }
    };

    let mut pending_hunk_start: (u32, u32) = (0, 0);

    for line in text.lines() {
        if let Some(caps) = diff_git_re().captures(line) {
            flush_hunk(
                &mut current,
                current_hunk.take(),
                pending_hunk_start.0,
                pending_hunk_start.1,
            );
            if let Some(f) = current.take() {
                files.push(f.finish());
            }
            current = Some(InProgressFile::new(&caps[1], &caps[2]));
            continue;
        }
        let Some(f) = current.as_mut() else { continue };

        if let Some(rest) = line.strip_prefix("old mode ") {
            f.old_mode = Some(rest.to_string());
        } else if let Some(rest) = line.strip_prefix("new mode ") {
            f.new_mode = Some(rest.to_string());
        } else if line.starts_with("new file mode") {
            f.status = FileStatus::Added;
        } else if line.starts_with("deleted file mode") {
            f.status = FileStatus::Deleted;
        } else if let Some(rest) = line.strip_prefix("rename from ") {
            f.status = FileStatus::Renamed;
            f.old_path = Some(rest.to_string());
        } else if line.strip_prefix("rename to ").is_some() {
            f.status = FileStatus::Renamed;
        } else if let Some(rest) = line.strip_prefix("copy from ") {
            f.status = FileStatus::Copied;
            f.old_path = Some(rest.to_string());
        } else if line.strip_prefix("copy to ").is_some() {
            f.status = FileStatus::Copied;
        } else if let Some(rest) = line.strip_prefix("similarity index ") {
            if let Ok(pct) = rest.trim_end_matches('%').parse::<u8>() {
                f.similarity = Some(pct);
            }
        } else if line.contains("Binary files") && line.ends_with("differ") {
            f.flags.push(FileFlag::Binary {
                old_size: None,
                new_size: None,
            });
        } else if let Some(caps) = hunk_header_re().captures(line) {
            flush_hunk(
                &mut current,
                current_hunk.take(),
                pending_hunk_start.0,
                pending_hunk_start.1,
            );
            let old_start: u32 = caps[1].parse().unwrap_or(0);
            let new_start: u32 = caps[3].parse().unwrap_or(0);
            pending_hunk_start = (old_start, new_start);
            current_hunk = Some((old_start, new_start, caps[5].trim().to_string(), vec![]));
        } else if let Some((old_no, new_no, _, lines)) = current_hunk.as_mut() {
            if line.starts_with('\\') {
                continue; // "\ No newline at end of file"
            }
            let (kind, text) = match line.split_at_checked(1) {
                Some(("+", rest)) => (LineKind::Add, rest),
                Some(("-", rest)) => (LineKind::Del, rest),
                Some((" ", rest)) => (LineKind::Ctx, rest),
                _ if line.is_empty() => (LineKind::Ctx, ""),
                _ => (LineKind::Ctx, line),
            };
            let (old_line, new_line) = match kind {
                LineKind::Add => {
                    let n = *new_no;
                    *new_no += 1;
                    (None, Some(n))
                }
                LineKind::Del => {
                    let o = *old_no;
                    *old_no += 1;
                    (Some(o), None)
                }
                LineKind::Ctx => {
                    let o = *old_no;
                    let n = *new_no;
                    *old_no += 1;
                    *new_no += 1;
                    (Some(o), Some(n))
                }
            };
            lines.push(DiffLine {
                kind,
                text: text.to_string(),
                old_no: old_line,
                new_no: new_line,
            });
        }
    }
    flush_hunk(
        &mut current,
        current_hunk.take(),
        pending_hunk_start.0,
        pending_hunk_start.1,
    );
    if let Some(f) = current.take() {
        files.push(f.finish());
    }

    if files.is_empty() {
        bail!("no `diff --git` sections found — is this a unified diff produced by `git diff`?");
    }

    Ok(Revision {
        base: Sha::new(base),
        head: Sha::new(head),
        files,
    })
}

/// Read and parse a diff file from disk.
pub fn read_file(path: &std::path::Path) -> Result<Revision> {
    let text = std::fs::read_to_string(path)
        .with_context(|| format!("reading diff file {}", path.display()))?;
    parse(&text, "base", "head")
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@ function foo() {
 line one
-line two
+line two changed
+line three
 line four
diff --git a/src/old.ts b/src/new.ts
similarity index 95%
rename from src/old.ts
rename to src/new.ts
index 3333333..4444444 100644
--- a/src/old.ts
+++ b/src/new.ts
@@ -1,2 +1,2 @@
-export const old = 1;
+export const neu = 1;
 export const other = 2;
diff --git a/pkg/new.ts b/pkg/new.ts
new file mode 100644
index 0000000..5555555
--- /dev/null
+++ b/pkg/new.ts
@@ -0,0 +1,2 @@
+export const x = 1;
+export const y = 2;
"#;

    #[test]
    fn parses_three_files() {
        let rev = parse(SAMPLE, "base", "head").unwrap();
        assert_eq!(rev.files.len(), 3);
        assert_eq!(rev.files[0].path, "src/a.ts");
        assert_eq!(rev.files[0].status, FileStatus::Modified);
        assert_eq!(rev.files[0].hunks.len(), 1);
        assert_eq!(rev.files[0].hunks[0].lines.len(), 5);
    }

    #[test]
    fn detects_rename() {
        let rev = parse(SAMPLE, "base", "head").unwrap();
        let f = &rev.files[1];
        assert_eq!(f.status, FileStatus::Renamed);
        assert_eq!(f.old_path.as_deref(), Some("src/old.ts"));
        assert_eq!(f.path, "src/new.ts");
        assert_eq!(f.similarity, Some(95));
    }

    #[test]
    fn detects_added_file() {
        let rev = parse(SAMPLE, "base", "head").unwrap();
        let f = &rev.files[2];
        assert_eq!(f.status, FileStatus::Added);
        assert_eq!(f.hunks[0].lines.len(), 2);
    }

    #[test]
    fn hunk_ids_are_stable_and_distinct() {
        let rev = parse(SAMPLE, "base", "head").unwrap();
        let ids: Vec<_> = rev.hunks().map(|h| h.id.clone()).collect();
        let unique: std::collections::BTreeSet<_> = ids.iter().collect();
        assert_eq!(ids.len(), unique.len());
    }

    #[test]
    fn rejects_non_diff_text() {
        assert!(parse("hello, this is not a diff", "b", "h").is_err());
    }
}
