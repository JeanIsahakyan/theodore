//! GitHub OAuth device flow (plan §6.8 "Auth"): a sign-in that needs
//! neither a pasted token nor `gh`. The trait lives here, not on
//! `HostAdapter`, because it runs before any token exists — there is
//! nothing yet to route by PR or repo. `app` depends on it without
//! depending on a specific host adapter crate; today's only implementation
//! wraps `theodore-host-github`'s device-flow client.

use async_trait::async_trait;

use crate::{HostError, HostResult};

/// Response to the first device-flow request: what the user is shown
/// (`user_code`, `verification_uri`) plus how to poll for the outcome.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceCodeStart {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u32,
    pub interval: u32,
}

/// One poll's outcome. `SlowDown` and the error variants mirror GitHub's
/// `error` field on `POST /login/oauth/access_token`; `Pending` is
/// `authorization_pending`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DevicePoll {
    Pending,
    /// The caller must wait at least `interval` seconds before polling
    /// again — already bumped from the last interval if the host didn't
    /// say otherwise (plan "login": +5s per GitHub's own spec).
    SlowDown {
        interval: u32,
    },
    AccessDenied,
    ExpiredToken,
    Success {
        access_token: String,
    },
}

#[async_trait]
pub trait DeviceLoginPort: Send + Sync {
    /// Starts a device-flow login for an OAuth app with `client_id`,
    /// requesting `scope` (space-separated, e.g. `"repo read:org"`).
    async fn start(&self, client_id: &str, scope: &str) -> HostResult<DeviceCodeStart>;

    /// Polls once for `device_code`'s outcome. `current_interval` is the
    /// caller's current poll interval (seconds), used to compute the next
    /// one on `SlowDown` when the host's response doesn't say.
    async fn poll(
        &self,
        client_id: &str,
        device_code: &str,
        current_interval: u32,
    ) -> HostResult<DevicePoll>;
}

/// Always `Unsupported` — a stand-in for a shell that hasn't wired a real
/// `DeviceLoginPort` (e.g. no client id configured yet).
pub struct NoDeviceLogin;

#[async_trait]
impl DeviceLoginPort for NoDeviceLogin {
    async fn start(&self, _client_id: &str, _scope: &str) -> HostResult<DeviceCodeStart> {
        Err(HostError::Unsupported("device_login"))
    }
    async fn poll(
        &self,
        _client_id: &str,
        _device_code: &str,
        _current_interval: u32,
    ) -> HostResult<DevicePoll> {
        Err(HostError::Unsupported("device_login"))
    }
}
