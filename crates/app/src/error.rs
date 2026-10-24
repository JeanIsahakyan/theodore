//! App-level errors. Command handlers (shell side) turn these into
//! `contract::CommandError`.

use theodore_ports::{AccountError, GitError, HostError, StoreError};

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("store: {0}")]
    Store(#[from] StoreError),
    #[error("git: {0}")]
    Git(#[from] GitError),
    #[error("host: {0}")]
    Host(#[from] HostError),
    #[error("grouping: {0}")]
    Grouper(#[from] GrouperError),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("invalid request: {0}")]
    Invalid(String),
    #[error("background task failed: {0}")]
    Join(String),
    #[error("account: {0}")]
    Account(#[from] AccountError),
    /// Signing in to the Theodore account is required here and nobody is
    /// signed in (plan §6.12 "Sign-in required").
    #[error("Sign in to your Theodore account to continue")]
    AccountRequired,
}

impl AppError {
    pub fn join(e: tokio::task::JoinError) -> Self {
        AppError::Join(e.to_string())
    }
}

/// Errors from a `Grouper` run (plan §5.1).
#[derive(Debug, thiserror::Error)]
pub enum GrouperError {
    #[error("agent failed: {0}")]
    Agent(String),
    #[error("invalid output: {0}")]
    Invalid(String),
}

pub type AppResult<T> = Result<T, AppError>;
