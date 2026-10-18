//! GitLab HostAdapter: REST v4 (plan §6, M7).

mod adapter;
mod anchor;
mod model;
mod pagination;
mod rest;
mod time;

pub use adapter::GitlabAdapter;
