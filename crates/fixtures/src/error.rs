//! Errors from loading fixture data off disk.

use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum FixtureError {
    #[error("io error at {path}: {source}")]
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("invalid json in {path}: {source}")]
    Json {
        path: PathBuf,
        source: serde_json::Error,
    },
}
