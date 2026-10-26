//! Bitbucket Cloud accepts either an app password (Basic auth, keyed by the
//! account's username/nickname) or a repository/workspace access token
//! (Bearer). A `TokenSource` only ever hands back one opaque string (plan
//! §6.8 stores a single value per host), so the two forms are told apart by
//! shape: `username:app_password` (one `:`, matching the form Bitbucket's
//! own docs paste as a single string) is Basic; anything else is sent as a
//! Bearer token.

use theodore_host_http::TokenSource;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Credentials {
    Basic {
        username: String,
        app_password: String,
    },
    Bearer(String),
    None,
}

impl Credentials {
    pub fn from_token(token: Option<String>) -> Self {
        match token {
            None => Credentials::None,
            Some(raw) => match raw.split_once(':') {
                Some((username, app_password))
                    if !username.is_empty() && !app_password.is_empty() =>
                {
                    Credentials::Basic {
                        username: username.to_string(),
                        app_password: app_password.to_string(),
                    }
                }
                _ => Credentials::Bearer(raw),
            },
        }
    }

    pub fn from_source(source: &dyn TokenSource) -> Self {
        Self::from_token(source.token())
    }

    /// The secret portion(s) to scrub from logged/returned error text.
    pub(crate) fn secrets(&self) -> Vec<&str> {
        match self {
            Credentials::Basic { app_password, .. } => vec![app_password.as_str()],
            Credentials::Bearer(t) => vec![t.as_str()],
            Credentials::None => vec![],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn username_colon_app_password_is_basic() {
        let c = Credentials::from_token(Some("jsmith:ATBBxxx".to_string()));
        assert_eq!(
            c,
            Credentials::Basic {
                username: "jsmith".to_string(),
                app_password: "ATBBxxx".to_string(),
            }
        );
    }

    #[test]
    fn bare_token_is_bearer() {
        let c = Credentials::from_token(Some("ATCTxxx".to_string()));
        assert_eq!(c, Credentials::Bearer("ATCTxxx".to_string()));
    }

    #[test]
    fn no_token_is_none() {
        assert_eq!(Credentials::from_token(None), Credentials::None);
    }

    #[test]
    fn empty_username_or_password_falls_back_to_bearer() {
        assert_eq!(
            Credentials::from_token(Some(":pw".to_string())),
            Credentials::Bearer(":pw".to_string())
        );
        assert_eq!(
            Credentials::from_token(Some("user:".to_string())),
            Credentials::Bearer("user:".to_string())
        );
    }
}
