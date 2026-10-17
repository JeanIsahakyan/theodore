//! Grouping pipeline (plan §5): pre-pass, agent prompt, validation, repair,
//! incremental regroup. The only I/O is through `theodore_ports::AgentPort`.

pub mod incremental;
mod parse;
pub mod pipeline;
pub mod prepass;
pub mod prompt;
mod schema;

pub mod testing;

pub use incremental::regroup;
pub use pipeline::{
    GroupingOptions, GroupingPipelineError, GroupingReport, PrMeta, group_revision,
};
pub use prompt::PromptBudget;
