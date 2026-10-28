//! Grouping pipeline (plan §5): pre-pass, agent prompt, validation, repair,
//! incremental regroup. The only I/O is through `theodore_ports::AgentPort`.

mod area;
mod coarsen;
pub mod graph;
pub mod incremental;
mod parse;
pub mod pipeline;
pub mod prepass;
pub mod prompt;
mod schema;
pub mod skeleton;
pub mod stream;
mod target;

pub mod testing;

pub use incremental::{regroup, regroup_with};
pub use pipeline::{
    GroupingOptions, GroupingPipelineError, GroupingReport, OnProgress, PrMeta, Progress, Stage,
    StreamTimings, group_revision, group_revision_progress, group_revision_with,
};
pub use prompt::PromptBudget;
