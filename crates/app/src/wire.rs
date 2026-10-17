//! Conversions between `ports`/`domain` (store-side) and `contract`
//! (wire-side) shapes. Both sides intentionally mirror each other field for
//! field; this module is the one place that says so.

use serde::{Deserialize, Serialize};
use theodore_contract::{SyncCode, WireAction, WireRow};
use theodore_domain::{PrId, Thread};
use theodore_ports::{ModelRow, SyncAction, SyncActionCode};

pub fn to_wire_code(code: SyncActionCode) -> SyncCode {
    match code {
        SyncActionCode::I => SyncCode::I,
        SyncActionCode::U => SyncCode::U,
        SyncActionCode::C => SyncCode::C,
        SyncActionCode::A => SyncCode::A,
        SyncActionCode::D => SyncCode::D,
    }
}

pub fn to_wire_action(a: SyncAction) -> WireAction {
    WireAction {
        id: a.id,
        model: a.model,
        model_id: a.model_id,
        action: to_wire_code(a.action),
        data: a.data,
    }
}

pub fn to_wire_row(r: ModelRow) -> WireRow {
    WireRow {
        model: r.model,
        id: r.id,
        data: r.data,
        archived: r.archived,
    }
}

/// `Thread` has no `pr` field of its own (it nests inside `PrDetail` on
/// open); top-level `thread` sync rows need one to be queryable by PR.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThreadRow {
    pub pr: PrId,
    #[serde(flatten)]
    pub thread: Thread,
}
