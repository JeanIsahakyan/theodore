//! `file_preview`: what hovering a file in a chat shows. Only git objects are
//! read, so a path outside the repo finds nothing.
//!
//! ```text
//! source ──▶ which commits
//!   space, its turn in turn_log  before ──▶ after          pinned
//!   space, a running turn        last checkpoint ──▶ worktree snapshot
//!   space, no turn on record     base ──▶ worktree snapshot
//!   pr                           merge-base ──▶ head       pinned
//!
//! path ─┬─ an image ──────────────────────────▶ the image at `to`
//!       ├─ changed between them ──────────────▶ its diff, capped
//!       ├─ binary ────────────────────────────▶ no preview, its size
//!       └─ otherwise ─────────────────────────▶ its first lines at `to`
//! ```

use std::path::{Path, PathBuf};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use theodore_contract::{
    FilePreview, FilePreviewAnswer, FilePreviewRequest, PreviewGap, PreviewSource,
};
use theodore_domain::{FileDiff, FileFlag, Sha};
use theodore_ports::DiffOptions;

use crate::core::Core;
use crate::error::AppResult;
use crate::usecases::revision::{OPAQUE_MIME, mime_for};

/// Lines of a diff or a file a popover shows.
const MAX_LINES: usize = 400;
/// A line this long is minified or generated: nobody reads the rest.
const MAX_LINE_CHARS: usize = 2000;
/// How much of a text file is read.
const MAX_TEXT_BYTES: usize = 128 * 1024;
/// A bigger image isn't read at all.
const MAX_IMAGE_BYTES: u64 = 5 * 1024 * 1024;
/// How far into a file a NUL byte means binary (git's own heuristic).
const SNIFF_BYTES: usize = 8000;

struct Target {
    repo: PathBuf,
    from: Sha,
    to: Sha,
    pinned: bool,
}

impl Core {
    pub async fn file_preview(&self, req: FilePreviewRequest) -> AppResult<FilePreviewAnswer> {
        let Some(path) = repo_path(&req.path) else {
            return Ok(FilePreviewAnswer {
                preview: unavailable(PreviewGap::Missing, None),
                pinned: true,
            });
        };
        let target = self.preview_target(&req.source).await?;
        Ok(FilePreviewAnswer {
            preview: self.preview_of(&target, path).await?,
            pinned: target.pinned,
        })
    }

    async fn preview_target(&self, source: &PreviewSource) -> AppResult<Target> {
        match source {
            PreviewSource::Pr { pr } => {
                self.ensure_open(pr).await?;
                let detail = self.load_pr_detail(pr).await?;
                let repo = self.open_pr_repo(pr).await?;
                let to = self.pr_head(pr, &detail).await;
                let from = self
                    .0
                    .deps
                    .git
                    .merge_base(&repo, &detail.base_sha, &to)
                    .await?;
                Ok(Target {
                    repo,
                    from,
                    to,
                    pinned: true,
                })
            }
            PreviewSource::Space { space, reply } => {
                let row = self.space_row(space).await?;
                let worktree = Path::new(&row.worktree);
                let alive = worktree.exists();
                let repo = if alive {
                    worktree.to_path_buf()
                } else {
                    let project = self.space_project(&row).await?;
                    self.ensure_project_cache(&project).await?
                };
                let turn = reply
                    .as_ref()
                    .and_then(|r| row.turn_log.iter().find(|t| &t.reply == r));
                if let Some(turn) = turn {
                    return Ok(Target {
                        repo,
                        from: turn.before.clone(),
                        to: turn.after.clone(),
                        pinned: true,
                    });
                }
                let to = if alive {
                    self.0.deps.git.space_snapshot(worktree).await?
                } else {
                    row.head_sha.clone()
                };
                // The running turn's edits so far; a reply whose turn left
                // no checkpoint has only the space's change to go by.
                let from = if reply.is_none() {
                    row.head_sha.clone()
                } else {
                    row.base_sha.clone()
                };
                Ok(Target {
                    repo,
                    from,
                    to,
                    pinned: false,
                })
            }
        }
    }

    async fn preview_of(&self, t: &Target, path: &str) -> AppResult<FilePreview> {
        let git = &self.0.deps.git;
        let mime = mime_for(path);
        if mime != OPAQUE_MIME {
            let Some(bytes) = git.blob_size(&t.repo, &t.to, path).await? else {
                return Ok(unavailable(PreviewGap::Missing, None));
            };
            if bytes > MAX_IMAGE_BYTES {
                return Ok(unavailable(PreviewGap::TooLarge, Some(bytes)));
            }
            let Some(data) = git.show(&t.repo, &t.to, path).await? else {
                return Ok(unavailable(PreviewGap::Missing, None));
            };
            return Ok(FilePreview::Image {
                mime: mime.to_string(),
                base64: BASE64.encode(&data),
                bytes,
            });
        }
        if t.from != t.to
            && let Some(mut file) = git
                .diff_file(&t.repo, &t.from, &t.to, path, &DiffOptions::default())
                .await?
        {
            if let Some(FileFlag::Binary { new_size, .. }) = file
                .flags
                .iter()
                .find(|f| matches!(f, FileFlag::Binary { .. }))
            {
                return Ok(unavailable(PreviewGap::Binary, *new_size));
            }
            if !file.hunks.is_empty() {
                let more_lines = cap_diff(&mut file);
                return Ok(FilePreview::Diff { file, more_lines });
            }
        }
        let Some(size) = git.blob_size(&t.repo, &t.to, path).await? else {
            return Ok(unavailable(PreviewGap::Missing, None));
        };
        let head = git.blob_head(&t.repo, &t.to, path, MAX_TEXT_BYTES).await?;
        if head.iter().take(SNIFF_BYTES).any(|b| *b == 0) {
            return Ok(unavailable(PreviewGap::Binary, Some(size)));
        }
        Ok(text_preview(&head, size))
    }
}

fn unavailable(reason: PreviewGap, bytes: Option<u64>) -> FilePreview {
    FilePreview::Unavailable { reason, bytes }
}

/// A path inside the repo, as git names it. Agents can name anything: an
/// absolute path, `../` or an empty one finds nothing to preview.
fn repo_path(path: &str) -> Option<&str> {
    let path = path.strip_prefix("./").unwrap_or(path);
    let plain = !path.is_empty()
        && !path.starts_with('/')
        && !path.contains('\n')
        && path
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..");
    plain.then_some(path)
}

fn clipped(line: &str) -> String {
    match line.char_indices().nth(MAX_LINE_CHARS) {
        Some((at, _)) => format!("{}…", &line[..at]),
        None => line.to_string(),
    }
}

/// Keeps the first `MAX_LINES` lines of the diff; the count of the others.
fn cap_diff(file: &mut FileDiff) -> u32 {
    let mut left = MAX_LINES;
    let mut dropped = 0;
    for hunk in &mut file.hunks {
        if hunk.lines.len() > left {
            dropped += hunk.lines.len() - left;
            hunk.lines.truncate(left);
        }
        left -= hunk.lines.len();
        for line in &mut hunk.lines {
            if line.text.len() > MAX_LINE_CHARS {
                line.text = clipped(&line.text);
            }
        }
    }
    file.hunks.retain(|h| !h.lines.is_empty());
    u32::try_from(dropped).unwrap_or(u32::MAX)
}

/// `head`: the start of a file of `size` bytes.
fn text_preview(head: &[u8], size: u64) -> FilePreview {
    let cut = size > head.len() as u64;
    let text = String::from_utf8_lossy(head);
    let mut lines: Vec<&str> = text.lines().collect();
    // Read up to a byte limit, the last line is likely half of one.
    if cut && lines.len() > 1 {
        lines.pop();
    }
    let more_lines = lines.len().saturating_sub(MAX_LINES);
    lines.truncate(MAX_LINES);
    FilePreview::Text {
        text: lines
            .iter()
            .map(|l| clipped(l))
            .collect::<Vec<_>>()
            .join("\n"),
        bytes: size,
        more_lines: u32::try_from(more_lines).unwrap_or(u32::MAX),
        cut,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_path_inside_the_repo_is_looked_up() {
        assert_eq!(repo_path("src/a.rs"), Some("src/a.rs"));
        assert_eq!(repo_path("./src/a.rs"), Some("src/a.rs"));
        assert_eq!(repo_path("name with space.rs"), Some("name with space.rs"));
        for bad in ["", "/etc/passwd", "../secret", "a/../../b", "a//b", "a\nb"] {
            assert_eq!(repo_path(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn a_big_text_is_capped_by_lines_and_counts_the_rest() {
        let text = (0..MAX_LINES + 5)
            .map(|n| format!("line {n}"))
            .collect::<Vec<_>>()
            .join("\n");
        let FilePreview::Text {
            text: shown,
            more_lines,
            cut,
            ..
        } = text_preview(text.as_bytes(), text.len() as u64)
        else {
            panic!("expected text");
        };
        assert_eq!(shown.lines().count(), MAX_LINES);
        assert_eq!(more_lines, 5);
        assert!(!cut);
    }

    #[test]
    fn a_file_read_only_in_part_says_so_and_drops_its_half_line() {
        let FilePreview::Text {
            text,
            more_lines,
            cut,
            bytes,
        } = text_preview(b"one\ntwo\nthr", 1_000_000)
        else {
            panic!("expected text");
        };
        assert_eq!(text, "one\ntwo");
        assert_eq!(more_lines, 0);
        assert!(cut);
        assert_eq!(bytes, 1_000_000);
    }

    #[test]
    fn a_very_long_line_is_clipped_on_a_char_boundary() {
        let line = "é".repeat(MAX_LINE_CHARS + 10);
        let shown = clipped(&line);
        assert!(shown.ends_with('…'));
        assert_eq!(shown.chars().count(), MAX_LINE_CHARS + 1);
    }
}
