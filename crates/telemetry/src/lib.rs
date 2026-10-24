//! Telemetry (docs/telemetry.md). Work in progress.

pub mod report {
    /// Whether `path` is inside the problem-reports folder.
    pub fn is_report_path(_path: &std::path::Path) -> bool {
        false
    }
}

pub fn client_log(_entry: &theodore_contract::ClientLog) {}

pub fn track_ui(_event: &theodore_contract::UiEvent) {}
