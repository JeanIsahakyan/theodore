//! Fleet, delegations (docs/mobile.md "Following a computer's spaces"):
//! this device lets a phone or web app it trusts follow the spaces it
//! started (subscribe to them, get their questions) by signing a
//! `Delegation` for the cloud. A delegation grants nothing on hosts: a
//! delegate's answer runs there only if the host trusts the delegate's key.
//!
//! ```text
//! Devices → "Send my spaces' questions here" ─▶ fleet_delegate(id, on)
//!   on  ─▶ a phone / web app, pinned with its listed key ─▶ delegates += id
//!         ─▶ delegate{seal_as(Delegation{me, id, now, 0, revoke: false}, Delegate)}
//!   off ─▶ delegates -= id ─▶ the same, revoke: true
//! untrust / remove ─▶ off
//! welcome ─▶ devices ─▶ every wanted delegate listed in this org, signed again
//! delegations{list} ─▶ each one: origin me ─▶ open with my own key
//!                                delegate me ─▶ open with the origin's pin
//!                                else, or doesn't verify ─▶ dropped
//!   ─▶ kept (FleetDevice.delegation_live)
//!   ─▶ one of mine not wanted any more ─▶ revoked, once per connection
//! ```

use theodore_contract::{Ephemeral, FleetStatus};
use theodore_fleet_protocol::{ClientMessage, Delegation, Domain, SignedEnvelope};

use crate::core::Core;
use crate::error::{AppError, AppResult};
use crate::usecases::fleet::wants_delegate;

impl Core {
    /// Sends this device's spaces' questions to `device_id` (a phone or
    /// web app trusted here), or stops. Kept in the settings, so it's
    /// signed again after every welcome; off goes out as a revocation.
    pub async fn fleet_delegate(&self, device_id: &str, on: bool) -> AppResult<FleetStatus> {
        if on {
            let listed = self
                .fleet()
                .devices
                .iter()
                .find(|d| d.device_id == device_id)
                .cloned()
                .ok_or_else(|| {
                    AppError::NotFound(format!(
                        "device {device_id} isn't in this organization's fleet"
                    ))
                })?;
            if listed.info.kind.hosts() {
                return Err(AppError::Invalid(format!(
                    "{} is a computer: only a phone or the web app follows this device's spaces",
                    listed.info.name
                )));
            }
            let pinned = self.fleet_pinned(device_id).await;
            if !pinned.is_some_and(|p| p.public_key == listed.public_key) {
                return Err(AppError::Invalid(format!(
                    "trust {} first: only a device you trust gets your spaces' questions",
                    listed.info.name
                )));
            }
        }
        {
            let _g = self.0.fleet.settings_lock.lock().await;
            let mut s = self.fleet_settings().await;
            s.delegates.retain(|d| d != device_id);
            if on {
                s.delegates.push(device_id.to_string());
            }
            self.fleet_save_settings(&s).await?;
        }
        if on {
            self.fleet().revoked.remove(device_id);
        }
        // Not connected: the next welcome signs it (on), or the cloud's
        // list shows it still held and it's revoked then (off).
        self.fleet_send_delegation(device_id, !on).await;
        tracing::info!(device = %device_id, on, "fleet delegation changed");
        let status = self.fleet_status().await?;
        self.emit(Ephemeral::FleetStatus {
            status: status.clone(),
        });
        Ok(status)
    }

    /// Signs a delegation to `delegate` (or its revocation) and sends it;
    /// `false` when not connected.
    pub(crate) async fn fleet_send_delegation(&self, delegate: &str, revoke: bool) -> bool {
        let me = {
            let mem = self.fleet();
            match (&mem.device_id, mem.connected) {
                (Some(id), true) => id.clone(),
                _ => return false,
            }
        };
        let key = match self.fleet_key().await {
            Ok(k) => k,
            Err(e) => {
                tracing::warn!(error.code = e.code(), error = %e, "no fleet device key to sign a delegation");
                return false;
            }
        };
        let body = Delegation {
            origin_device: me,
            delegate_device: delegate.to_string(),
            issued_at_ms: self.0.deps.clock.now().max(0) as u64,
            expires_at_ms: 0,
            revoke,
        };
        let envelope = SignedEnvelope::seal_as(&body, &key, Domain::Delegate);
        if revoke {
            self.fleet().revoked.insert(delegate.to_string());
        }
        self.fleet_send_msg(ClientMessage::Delegate { envelope })
    }

    /// `device` was untrusted or removed: a delegation to it, asked for
    /// here (`asked`) or held by the cloud, is withdrawn.
    pub(crate) async fn fleet_revoke_if_held(&self, device: &str, asked: bool) {
        let live = {
            let mem = self.fleet();
            mem.device_id.as_deref().is_some_and(|me| {
                mem.delegations
                    .iter()
                    .any(|d| d.origin_device == me && d.delegate_device == device)
            })
        };
        if asked || live {
            self.fleet_send_delegation(device, true).await;
        }
    }

    /// After a welcome, once the device list came: every delegation still
    /// wanted, signed again (the cloud may have lost it). Only delegates
    /// listed in this organization: device ids are per hub.
    pub(crate) async fn fleet_resend_delegations(&self) {
        if !std::mem::take(&mut self.fleet().delegations_due) {
            return;
        }
        let s = self.fleet_settings().await;
        let wanted: Vec<String> = self
            .fleet()
            .devices
            .iter()
            .filter(|d| wants_delegate(&s, d))
            .map(|d| d.device_id.clone())
            .collect();
        for d in wanted {
            self.fleet_send_delegation(&d, false).await;
        }
    }

    /// The cloud's live delegations naming this device: only those that
    /// verify (this device's own against its key, another's against that
    /// origin's pin) are kept. One of this device's own that it no longer
    /// wants is revoked.
    pub(crate) async fn fleet_on_delegations(&self, list: Vec<SignedEnvelope>) {
        let Some(me) = self.fleet().device_id.clone() else {
            return;
        };
        let mine = match self.fleet_key().await {
            Ok(k) => k.public_key(),
            Err(e) => {
                tracing::warn!(error.code = e.code(), error = %e, "no fleet device key to check delegations");
                return;
            }
        };
        let s = self.fleet_settings().await;
        let now = self.0.deps.clock.now().max(0) as u64;
        let mut kept: Vec<Delegation> = Vec::new();
        for envelope in list {
            let Ok(peeked) = envelope.peek_as::<Delegation>() else {
                tracing::debug!("dropped an unreadable delegation");
                continue;
            };
            let key = if peeked.origin_device == me {
                mine.clone()
            } else if peeked.delegate_device == me {
                match s
                    .trusted_devices
                    .iter()
                    .find(|t| t.device_id == peeked.origin_device)
                {
                    Some(t) => t.public_key.clone(),
                    None => {
                        tracing::debug!("dropped a delegation from a device not trusted here");
                        continue;
                    }
                }
            } else {
                tracing::debug!("dropped a delegation that doesn't name this device");
                continue;
            };
            let d = match envelope.open_as::<Delegation>(&key, Domain::Delegate) {
                Ok(d) => d,
                Err(e) => {
                    tracing::debug!(error = %e, "dropped a delegation that doesn't verify");
                    continue;
                }
            };
            if d.revoke
                || d.origin_device == d.delegate_device
                || (d.expires_at_ms != 0 && d.expires_at_ms <= now)
            {
                continue;
            }
            // The newest per pair.
            match kept.iter_mut().find(|k| {
                k.origin_device == d.origin_device && k.delegate_device == d.delegate_device
            }) {
                Some(k) if k.issued_at_ms >= d.issued_at_ms => {}
                Some(k) => *k = d,
                None => kept.push(d),
            }
        }
        let unwanted: Vec<String> = {
            let mut mem = self.fleet();
            let unwanted = kept
                .iter()
                .filter(|d| d.origin_device == me)
                .filter(|d| {
                    match mem
                        .devices
                        .iter()
                        .find(|x| x.device_id == d.delegate_device)
                    {
                        Some(listed) => !wants_delegate(&s, listed),
                        // Not listed (yet): only what the user turned off.
                        None => !s.delegates.contains(&d.delegate_device),
                    }
                })
                .filter(|d| !mem.revoked.contains(&d.delegate_device))
                .map(|d| d.delegate_device.clone())
                .collect();
            mem.delegations = kept;
            unwanted
        };
        for d in unwanted {
            tracing::info!(device = %d, "revoking a delegation this device no longer wants");
            self.fleet_send_delegation(&d, true).await;
        }
        self.fleet_emit_status().await;
    }
}
