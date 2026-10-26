//! Shared HTTP client for host adapters: auth, ETag cache, rate limits, retry, redaction.
//!
//! One [`HttpClient`] per API endpoint (REST root, GraphQL endpoint); adapters
//! own the host-specific request/response shapes, this crate owns the
//! generic transport concerns (plan §6.1, §6.8).

mod client;
mod rate;
mod redact;
mod token;

pub use client::{HttpClient, HttpResponse, RawResponse, RetryConfig};
pub use token::{StaticToken, TokenSource};
