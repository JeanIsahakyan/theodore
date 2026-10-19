//! Image diffs and locally-detected merge conflicts (slice `diff_media`).

use serde::{Deserialize, Serialize};
use specta::Type;
use theodore_domain::PrId;

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
