//! GitHub OAuth device flow (plan §6.8 "Auth"): `login_start`/`login_poll`
//! sign in without pasting a token or shelling out to `gh`.

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::HostAuthStatus;

/// `login_start`'s response: what to show the user, and how often
/// `login_poll` should be called while waiting.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct DeviceLogin {
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u32,
    pub interval: u32,
}

/// `login_poll`'s response.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum LoginState {
    Pending,
    /// Poll again no sooner than `interval` seconds from now (plan
    /// "login": GitHub's own device-flow spec bumps this by at least 5s
    /// each time it's hit).
    SlowDown {
        interval: u32,
    },
    Expired,
    Denied,
    Done {
        status: HostAuthStatus,
    },
}
