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
mod target;

pub mod testing;

pub use incremental::regroup;
pub use pipeline::{
    GroupingOptions, GroupingPipelineError, GroupingReport, PrMeta, group_revision,
    group_revision_with,
};
pub use prompt::PromptBudget;
