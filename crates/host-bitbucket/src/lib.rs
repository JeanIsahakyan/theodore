//! Bitbucket Cloud HostAdapter: REST API 2.0 (plan §6, M7).

mod adapter;
mod anchor;
mod auth;
mod http;
mod model;
mod pagination;
mod rest;
mod time;

pub use adapter::BitbucketAdapter;
pub use auth::Credentials;
