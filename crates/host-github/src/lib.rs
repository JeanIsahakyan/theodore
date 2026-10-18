//! GitHub HostAdapter: GraphQL (cynic) + REST, notifications polling.

mod adapter;
mod anchor;
mod graphql;
mod pagination;
mod rest;
pub mod testkit;
mod time;

pub use adapter::GithubAdapter;
