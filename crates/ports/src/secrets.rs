//! Secrets port (plan §9): one keychain item for all Theodore secrets.

#[derive(Debug, thiserror::Error)]
pub enum SecretsError {
    #[error("keychain: {0}")]
    Keychain(String),
    #[error("user denied keychain access")]
    Denied,
}

pub trait Secrets: Send + Sync {
    fn get(&self, key: &str) -> Result<Option<String>, SecretsError>;
    fn set(&self, key: &str, value: &str) -> Result<(), SecretsError>;
    fn delete(&self, key: &str) -> Result<(), SecretsError>;
}
