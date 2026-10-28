//! Shared HTTP client for host adapters: auth, conditional GETs, rate limits, retry, timeouts, redaction.
//!
//! One [`HttpClient`] per API endpoint (REST root, GraphQL endpoint); adapters
//! own the host-specific request/response shapes, this crate owns the
//! generic transport concerns (plan §6.1, §6.8).

mod client;
mod rate;
mod redact;
mod token;

pub use client::{
    CONNECT_TIMEOUT, HttpClient, HttpResponse, REQUEST_TIMEOUT, RawResponse, RetryConfig,
    host_reqwest_client,
};
pub use token::{StaticToken, TokenSource};
