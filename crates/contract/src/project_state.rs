//! A local folder project's working state (slice `projects`): what the
//! folder itself has checked out, read with git and never written to.

use serde::{Deserialize, Serialize};
use specta::Type;

/// `project_working_state`: the folder's checkout, next to the project's
/// `default_branch` in the header.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct ProjectWorkingState {
    /// Absolute path of the folder.
    pub path: String,
    /// The branch checked out in the folder; `None` on a detached HEAD.
    pub current_branch: Option<String>,
    /// Uncommitted paths: staged, unstaged and untracked.
    pub dirty_files: u32,
}
