use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum SandboxError {
    #[error("io error at {0:?}: {1}")]
    Io(PathBuf, std::io::Error),
    #[error("scenario: {0}")]
    Scenario(String),
    #[error("git {args}: {stderr}")]
    Git { args: String, stderr: String },
    #[error("{0}")]
    Invalid(String),
    #[error("state: {0}")]
    State(String),
}

pub type SandboxResult<T> = Result<T, SandboxError>;
