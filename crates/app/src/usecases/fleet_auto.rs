//! Fleet, auto mode (docs/fleet.md "Auto mode"): per Claude via cloud
//! (`mcp`) device pinned here, this computer may let its Edit (or Edit and
//! Run) go through without a person's yes. Kept on the pin, local only.
//! Auto never lifts `accept_remote` or `max_mode`: it only skips the prompt.
//!
//! ```text
//! fleet_set_auto{device, auto, until}
//!   host_device none ─▶ pin is mcp? ─▶ pin.auto, pin.auto_until_ms ─▶ saved
//!                       ─▶ announce (DeviceInfo.mcp_auto) ─▶ fleet_status
//!                       ─▶ a timer at `until`: off, announce, fleet_status
//!   host_device H    ─▶ signed set_mcp_auto ─▶ H (applies it if it trusts
//!                       this device and it isn't mcp)
//! gate: mcp + start/send in Edit|Run ─▶ auto covers the mode, not expired?
//!   yes ─▶ runs, logged "auto"       no ─▶ the prompt (a daemon: denied)
//! ```

use std::time::Duration;

use theodore_contract::{FleetAutoRequest, FleetStatus};
use theodore_fleet_protocol::{FleetMode, McpAuto, McpAutoState, RemoteOp};

use crate::core::Core;
use crate::error::{AppError, AppResult};
use crate::usecases::fleet::{FleetSettings, TrustedDevice, mode_str, wire_auto};
use crate::usecases::fleet_origin::{FleetFail, REPLY_WAIT};

/// The mode a start or send runs in (a send's resolved by the gate).
pub(crate) fn op_mode(op: &RemoteOp) -> Option<FleetMode> {
    match op {
        RemoteOp::StartSpace { mode, .. } => Some(*mode),
        RemoteOp::Send { mode, .. } => *mode,
        _ => None,
    }
}

fn auto_word(a: McpAuto) -> &'static str {
    match a {
        McpAuto::Off => "off",
        McpAuto::Edit => "edit",
        McpAuto::Full => "full",
    }
}

impl Core {
    fn fleet_now(&self) -> u64 {
        self.0.deps.clock.now().max(0) as u64
    }

    /// Whether `pin`'s auto mode lets `op` run here without a person now.
    pub(crate) fn fleet_auto_covers(&self, pin: &TrustedDevice, op: &RemoteOp) -> bool {
        op_mode(op).is_some_and(|m| pin.auto_at(self.fleet_now()).covers(m))
    }

    /// `DeviceInfo.mcp_auto`: the auto mode of each `mcp` device pinned
    /// here, so the user's other devices can show and change it.
    pub(crate) fn fleet_mcp_autos(&self, s: &FleetSettings) -> Vec<McpAutoState> {
        let now = self.fleet_now();
        s.trusted_devices
            .iter()
            .filter(|p| self.fleet_origin_mcp(p))
            .take(8)
            .map(|p| McpAutoState {
                device_id: p.device_id.clone(),
                auto: p.auto_at(now),
                until_ms: p.auto_until_at(now),
            })
            .collect()
    }

    /// `fleet_set_auto`: here, or on another computer you trust.
    pub async fn fleet_set_auto(&self, req: FleetAutoRequest) -> AppResult<FleetStatus> {
        let me = self.fleet().device_id.clone();
        let host = req
            .host_device
            .clone()
            .filter(|h| me.as_deref() != Some(h.as_str()));
        let auto = wire_auto(req.auto);
        match host {
            None => {
                self.fleet_apply_auto(&req.device_id, auto, req.until_ms, "here")
                    .await?
            }
            Some(host) => {
                let rx = self
                    .fleet_request(
                        &host,
                        RemoteOp::SetMcpAuto {
                            mcp_device: req.device_id.clone(),
                            auto,
                            until_ms: req.until_ms.filter(|_| auto != McpAuto::Off),
                        },
                        false,
                    )
                    .await?;
                Self::fleet_await(rx, REPLY_WAIT)
                    .await
                    .map_err(FleetFail::for_ui)?;
                tracing::info!(host = %host, device = %req.device_id, auto = auto_word(auto), "set auto mode on another computer");
            }
        }
        self.fleet_status().await
    }

    /// Sets `device`'s auto mode on this computer (`by`: who asked, for the
    /// log). Only for an `mcp` device pinned here; an end in the past is
    /// refused.
    pub(crate) async fn fleet_apply_auto(
        &self,
        device: &str,
        auto: McpAuto,
        until_ms: Option<u64>,
        by: &str,
    ) -> AppResult<()> {
        let now = self.fleet_now();
        let until = until_ms.filter(|_| auto != McpAuto::Off);
        if until.is_some_and(|u| u <= now) {
            return Err(AppError::Invalid("that end time has passed already".into()));
        }
        {
            let _g = self.0.fleet.settings_lock.lock().await;
            let mut s = self.fleet_settings().await;
            let Some(i) = s.trusted_devices.iter().position(|t| t.device_id == device) else {
                return Err(AppError::NotFound(
                    "that device isn't trusted on this computer".into(),
                ));
            };
            if !self.fleet_origin_mcp(&s.trusted_devices[i]) {
                return Err(AppError::Invalid(
                    "auto mode is only for Claude via cloud: other devices need no yes".into(),
                ));
            }
            let pin = &mut s.trusted_devices[i];
            pin.auto = auto;
            pin.auto_until_ms = until;
            self.fleet_save_settings(&s).await?;
        }
        tracing::info!(
            device = %device,
            auto = auto_word(auto),
            until_ms = until.unwrap_or(0),
            by,
            "fleet auto mode changed"
        );
        if let Some(u) = until {
            self.fleet_auto_timer(u);
        }
        self.fleet_announce().await;
        self.fleet_emit_status().await;
        Ok(())
    }

    /// Turns off every auto mode whose end has passed; tells the cloud and
    /// the UI when one did.
    pub(crate) async fn fleet_expire_autos(&self) {
        let now = self.fleet_now();
        let expired: Vec<String> = {
            let _g = self.0.fleet.settings_lock.lock().await;
            let mut s = self.fleet_settings().await;
            let mut expired = Vec::new();
            for p in &mut s.trusted_devices {
                if p.auto != McpAuto::Off && p.auto_until_ms.is_some_and(|u| u <= now) {
                    p.auto = McpAuto::Off;
                    p.auto_until_ms = None;
                    expired.push(p.device_id.clone());
                }
            }
            if expired.is_empty() {
                return;
            }
            if let Err(e) = self.fleet_save_settings(&s).await {
                tracing::warn!(error.code = e.code(), error = %e, "couldn't turn off an expired auto mode");
            }
            expired
        };
        for d in &expired {
            tracing::info!(device = %d, "fleet auto mode ended");
        }
        self.fleet_announce().await;
        self.fleet_emit_status().await;
    }

    /// At `until`, an auto mode that ends then is turned off. One timer per
    /// change; a later change makes another, and an early one finds nothing.
    fn fleet_auto_timer(&self, until: u64) {
        let core = self.clone();
        tokio::spawn(async move {
            let clock = core.0.deps.clock.clone();
            let left = until.saturating_sub(core.fleet_now());
            tokio::select! {
                () = clock.sleep(Duration::from_millis(left)) => core.fleet_expire_autos().await,
                () = core.0.shutdown.cancelled() => {}
            }
        });
    }

    /// At start: what ended while the app was closed goes off; the rest
    /// get their timers.
    pub(crate) async fn fleet_auto_resume(&self) {
        self.fleet_expire_autos().await;
        for p in self.fleet_settings().await.trusted_devices {
            if p.auto != McpAuto::Off
                && let Some(u) = p.auto_until_ms
            {
                self.fleet_auto_timer(u);
            }
        }
    }

    /// The auto mode a request from `pin` runs under, if any, for the log.
    pub(crate) fn fleet_auto_note(&self, pin: &TrustedDevice, op: &RemoteOp) -> String {
        format!(
            "{} ({})",
            auto_word(pin.auto_at(self.fleet_now())),
            op_mode(op).map_or("", mode_str)
        )
    }
}
