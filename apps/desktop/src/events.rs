//! Core → UI events (plan §3, `.context/commands.md`). The core feeds these
//! through a channel; `CoreEvents` turns each item into a Tauri event.

use tauri::{AppHandle, Emitter, Runtime};
use theodore_contract::{Ephemeral, SyncFrame, UpdateInfo};

pub const EVENT_SYNC: &str = "sync";
pub const EVENT_EPHEMERAL: &str = "ephemeral";
pub const EVENT_UPDATE: &str = "update";

/// Emits the three wire events to every window.
pub struct CoreEvents<R: Runtime> {
    app: AppHandle<R>,
}

impl<R: Runtime> Clone for CoreEvents<R> {
    fn clone(&self) -> Self {
        Self {
            app: self.app.clone(),
        }
    }
}

/// Builds the emitter for `app`.
pub fn emitter<R: Runtime>(app: AppHandle<R>) -> CoreEvents<R> {
    CoreEvents { app }
}

impl<R: Runtime> CoreEvents<R> {
    pub fn sync(&self, frame: SyncFrame) {
        if let Err(err) = self.app.emit(EVENT_SYNC, frame) {
            tracing::warn!(?err, "failed to emit sync event");
        }
    }

    pub fn ephemeral(&self, ev: Ephemeral) {
        if let Err(err) = self.app.emit(EVENT_EPHEMERAL, ev) {
            tracing::warn!(?err, "failed to emit ephemeral event");
        }
    }

    pub fn update(&self, info: UpdateInfo) {
        if let Err(err) = self.app.emit(EVENT_UPDATE, info) {
            tracing::warn!(?err, "failed to emit update event");
        }
    }
}
