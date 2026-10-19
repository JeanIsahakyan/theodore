//! Go-to-definition / find-references without a full LSP (slice `symbols`):
//! `find_symbol` greps the PR head worktree for a name and classifies each
//! hit as a definition or a plain reference.

use serde::{Deserialize, Serialize};
use specta::Type;
use theodore_domain::PrId;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct FindSymbolRequest {
    pub pr: PrId,
    pub name: String,
    /// Narrows the search to one language's definition patterns (e.g.
    /// `"rust"`, `"typescript"`); `None` tries every supported language.
    pub lang: Option<String>,
    /// The file the click came from. Hits in it, or near it, rank first.
    pub from_path: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum SymbolKind {
    Definition,
    Reference,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct SymbolHit {
    pub path: String,
    pub line: u32,
    pub kind: SymbolKind,
    /// The matched source line, trimmed.
    pub preview: String,
}
