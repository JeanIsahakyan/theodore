//! Theodore account (plan "Theodore account"): an identity with Theodore
//! itself, separate from the host tokens; required wherever it's configured. `account_status`,
//! `account_sign_in_start` / `_poll` / `_cancel`, `account_sign_out`.

use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct AccountUser {
    pub id: String,
    pub email: String,
    /// First and last name joined; `None` when the provider has neither.
    pub name: Option<String>,
    pub avatar_url: Option<String>,
}

/// `available: false` hides the whole feature (no client id configured,
/// fixtures, sandbox). Signed in iff `user` is set.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct AccountStatus {
    pub available: bool,
    /// Signing in is required before the app does any work: until `user` is
    /// set, only the sign-in screen shows and the core answers every other
    /// command with `account_required`. Set wherever the account is
    /// available.
    #[serde(default)]
    pub required: bool,
    pub user: Option<AccountUser>,
    /// Signed out because the provider ended the session (revoked, or the
    /// maximum session length reached), not by the user: the sign-in
    /// screen says so. Cleared by the next sign-in or sign-out.
    #[serde(default)]
    pub session_ended: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum AccountSignInMethod {
    /// Hosted sign-in page in the system browser, back to the app through
    /// a loopback redirect.
    Browser,
    /// A short code confirmed on the web, from any browser or device.
    DeviceCode,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct AccountSignInRequest {
    pub method: AccountSignInMethod,
    /// Pre-fills the email on the hosted page (browser method only).
    #[serde(default)]
    pub email: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "method", rename_all = "snake_case")]
pub enum AccountSignInStart {
    /// Open `url` in the system browser.
    Browser { url: String },
    DeviceCode {
        user_code: String,
        verification_uri: String,
        /// `verification_uri` with the code pre-filled.
        verification_uri_complete: Option<String>,
        expires_in: u32,
        interval: u32,
    },
}

/// `account_sign_in_poll`'s response.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum AccountSignInState {
    Pending,
    /// Device code only: poll again no sooner than `interval` seconds.
    SlowDown {
        interval: u32,
    },
    Expired,
    Denied,
    Failed {
        message: String,
    },
    Done {
        status: AccountStatus,
    },
}
