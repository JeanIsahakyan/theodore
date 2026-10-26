//! `--diff-file`: a standalone patch parsed with the git crate's parser.

use anyhow::{Context, Result};
use theodore_domain::{Revision, Sha};

/// Parse unified diff `text` into a `Revision`. `base`/`head` are whatever
/// labels the caller wants recorded — a raw patch carries no shas of its own.
pub fn parse(text: &str, base: &str, head: &str) -> Result<Revision> {
    Ok(theodore_git::parse_patch(
        text,
        &Sha::new(base),
        &Sha::new(head),
        5_000,
    ))
}

/// Read and parse a diff file from disk.
pub fn read_file(path: &std::path::Path) -> Result<Revision> {
    let text = std::fs::read_to_string(path)
        .with_context(|| format!("reading diff file {}", path.display()))?;
    parse(&text, "base", "head")
}
