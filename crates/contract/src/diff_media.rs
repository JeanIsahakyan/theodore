//! Image diffs and locally-detected merge conflicts (slice `diff_media`).

use serde::{Deserialize, Serialize};
use specta::Type;
use theodore_domain::{FileDiff, PrId};

/// Which side of a changed file to fetch (`get_blob`): the PR's base
/// commit, or its current head.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum DiffSide {
    Base,
    Head,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct GetBlobRequest {
    pub pr: PrId,
    pub path: String,
    pub side: DiffSide,
}

/// A file's raw bytes at one side of a diff (plan "image diff"), for the UI
/// to render directly — `data:<mime>;base64,<base64>` is already a valid
/// image `src`. Rejects instead of filling `base64` past ~10 MB.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct BlobResponse {
    pub mime: String,
    pub base64: String,
    /// Original byte length (pre-base64) — the size the UI's "+3.2 KB" diff
    /// is computed from without decoding `base64` first.
    pub bytes: u64,
}

/// Where a file chip in a chat looks its file up (`file_preview`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PreviewSource {
    /// A space's chat. `reply`: the agent's reply, whose turn it is; none: the
    /// turn still running.
    Space {
        space: String,
        reply: Option<String>,
    },
    /// The review's AI panel: the PR's own diff.
    Pr { pr: PrId },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct FilePreviewRequest {
    pub source: PreviewSource,
    /// Relative to the repo's root.
    pub path: String,
}

/// Why a file shows no preview.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum PreviewGap {
    Missing,
    Binary,
    TooLarge,
}

/// What hovering a file shows. Every list in it is capped; `more_lines` says
/// how much of what was read didn't fit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FilePreview {
    /// It changed: its diff, at most `PREVIEW_MAX_LINES` lines.
    Diff { file: FileDiff, more_lines: u32 },
    /// It only was read, or the diff is too big to show: its first lines.
    /// `cut`: the file is longer than what was read, `more_lines` counts only
    /// what was.
    Text {
        text: String,
        bytes: u64,
        more_lines: u32,
        cut: bool,
    },
    Image {
        mime: String,
        base64: String,
        bytes: u64,
    },
    Unavailable {
        reason: PreviewGap,
        bytes: Option<u64>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct FilePreviewAnswer {
    pub preview: FilePreview,
    /// The file as of its turn or the PR's head, which doesn't change. `false`:
    /// the worktree as it is now, which a later hover may see differently.
    pub pinned: bool,
}

/// The `CONFLICT (<kind>): ...` tag `git merge-tree` reports for a path
/// (plan "conflicts"); `other` covers any future kind `git` adds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ConflictKind {
    Content,
    AddAdd,
    ModifyDelete,
    RenameDelete,
    RenameRename,
    DirectoryFile,
    Submodule,
    Other,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct ConflictFile {
    pub path: String,
    pub kind: ConflictKind,
}
