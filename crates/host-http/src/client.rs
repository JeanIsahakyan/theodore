use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use reqwest::header::HeaderMap;
use reqwest::{Method, StatusCode};
use serde::Serialize;
use serde::de::DeserializeOwned;
use theodore_ports::{Clock, Fetched, HostError, HostResult};

/// Unix milliseconds. `theodore_ports::HostError::RateLimited` uses the
/// domain's `Millis` alias (`i64`); host-http avoids a domain dependency by
/// spelling it out.
type Millis = i64;

use crate::rate::{RateState, is_rate_limited_403, reset_at_from_headers};
use crate::redact::redact;
use crate::token::TokenSource;

/// Retry policy for 5xx and network errors. 4xx (including 429, which maps to
/// `HostError::RateLimited`) are never retried here — the caller/outbox
/// decides.
#[derive(Debug, Clone)]
pub struct RetryConfig {
    pub max_retries: u32,
    pub base_delay: Duration,
    pub max_delay: Duration,
}

impl Default for RetryConfig {
    fn default() -> Self {
        Self {
            max_retries: 3,
            base_delay: Duration::from_millis(200),
            max_delay: Duration::from_secs(5),
        }
    }
}

/// A decoded JSON response plus the bits adapters read themselves
/// (`x-poll-interval`, `link`, …) — host-http only understands the generic
/// concerns (auth, ETag, rate limit, retry).
#[derive(Debug, Clone)]
pub struct HttpResponse<T> {
    pub value: T,
    pub etag: Option<String>,
    pub headers: HeaderMap,
}

enum Outcome {
    NotModified(HeaderMap),
    Ok { body: String, headers: HeaderMap },
}

/// Raw conditional GET for callers that use a header other than
/// `If-None-Match` (e.g. `/notifications` with `If-Modified-Since`) and still
/// need the headers on a 304 (`X-Poll-Interval` is sent either way).
#[derive(Debug, Clone)]
pub struct RawResponse {
    pub not_modified: bool,
    pub body: String,
    pub headers: HeaderMap,
}

/// Shared HTTP client for code-host adapters. One instance per API endpoint
/// (e.g. GitHub REST root and GitHub GraphQL each get their own, since they
/// have different base URLs on GitHub Enterprise).
pub struct HttpClient {
    client: reqwest::Client,
    base_url: url::Url,
    token: Arc<dyn TokenSource>,
    clock: Arc<dyn Clock>,
    etags: Mutex<HashMap<String, String>>,
    rate: Mutex<RateState>,
    retry: RetryConfig,
    user_agent: String,
    /// `accept` sent with requests that carry a body.
    accept: String,
}

impl HttpClient {
    /// `base_url` must end with `/` for REST-style relative paths to join
    /// correctly (e.g. `https://api.github.com/`). A GraphQL endpoint is a
    /// full URL with no further joining (call `post_json` with `path = ""`).
    pub fn new(base_url: url::Url, token: Arc<dyn TokenSource>, clock: Arc<dyn Clock>) -> Self {
        Self::with_reqwest_client(base_url, token, clock, reqwest::Client::new())
    }

    pub fn with_reqwest_client(
        base_url: url::Url,
        token: Arc<dyn TokenSource>,
        clock: Arc<dyn Clock>,
        client: reqwest::Client,
    ) -> Self {
        Self {
            client,
            base_url,
            token,
            clock,
            etags: Mutex::new(HashMap::new()),
            rate: Mutex::new(RateState::default()),
            retry: RetryConfig::default(),
            user_agent: "theodore".to_string(),
            accept: "application/vnd.github+json".to_string(),
        }
    }

    pub fn with_retry(mut self, retry: RetryConfig) -> Self {
        self.retry = retry;
        self
    }

    /// Media type for requests with a body (default: GitHub's).
    pub fn with_accept(mut self, accept: impl Into<String>) -> Self {
        self.accept = accept.into();
        self
    }

    pub fn with_user_agent(mut self, ua: impl Into<String>) -> Self {
        self.user_agent = ua.into();
        self
    }

    fn url_for(&self, path: &str) -> HostResult<url::Url> {
        if path.is_empty() {
            return Ok(self.base_url.clone());
        }
        self.base_url
            .join(path.trim_start_matches('/'))
            .map_err(|e| HostError::Protocol(format!("bad path {path:?}: {e}")))
    }

    fn now(&self) -> Millis {
        self.clock.now()
    }

    fn redact(&self, text: &str) -> String {
        redact(self.token.token().as_deref(), text)
    }

    /// GET, decoded as JSON. No conditional request.
    pub async fn get<T: DeserializeOwned>(&self, path: &str) -> HostResult<HttpResponse<T>> {
        match self.execute(Method::GET, path, None, &[]).await? {
            Outcome::Ok { body, headers } => {
                let value = self.decode(&body)?;
                let etag = extract_etag(&headers);
                Ok(HttpResponse {
                    value,
                    etag,
                    headers,
                })
            }
            Outcome::NotModified(_) => unreachable!("no conditional header sent"),
        }
    }

    /// GET with `If-None-Match`. Uses `if_none_match` when given, else the
    /// per-URL cache from the last `Modified` response for this path.
    pub async fn get_conditional<T: DeserializeOwned>(
        &self,
        path: &str,
        if_none_match: Option<&str>,
    ) -> HostResult<Fetched<HttpResponse<T>>> {
        let url = self.url_for(path)?;
        let key = url.to_string();
        let etag = if_none_match
            .map(|s| s.to_string())
            .or_else(|| self.etags.lock().expect("etag lock").get(&key).cloned());
        let headers: &[(&str, String)] = match &etag {
            Some(e) => &[("if-none-match", e.clone())],
            None => &[],
        };

        match self.execute(Method::GET, path, None, headers).await? {
            Outcome::NotModified(_) => Ok(Fetched::NotModified),
            Outcome::Ok { body, headers } => {
                let value = self.decode(&body)?;
                let etag = extract_etag(&headers);
                if let Some(e) = &etag {
                    self.etags.lock().expect("etag lock").insert(key, e.clone());
                }
                Ok(Fetched::Modified {
                    etag: etag.clone(),
                    value: HttpResponse {
                        value,
                        etag,
                        headers,
                    },
                })
            }
        }
    }

    /// Raw conditional GET with caller-chosen headers (e.g.
    /// `If-Modified-Since`). Headers are returned on both outcomes.
    pub async fn get_raw(&self, path: &str, headers: &[(&str, String)]) -> HostResult<RawResponse> {
        match self.execute(Method::GET, path, None, headers).await? {
            Outcome::NotModified(headers) => Ok(RawResponse {
                not_modified: true,
                body: String::new(),
                headers,
            }),
            Outcome::Ok { body, headers } => Ok(RawResponse {
                not_modified: false,
                body,
                headers,
            }),
        }
    }

    pub async fn post_json<B: Serialize + ?Sized, T: DeserializeOwned>(
        &self,
        path: &str,
        body: &B,
    ) -> HostResult<HttpResponse<T>> {
        self.body_request(Method::POST, path, body).await
    }

    pub async fn patch_json<B: Serialize + ?Sized, T: DeserializeOwned>(
        &self,
        path: &str,
        body: &B,
    ) -> HostResult<HttpResponse<T>> {
        self.body_request(Method::PATCH, path, body).await
    }

    pub async fn put_json<B: Serialize + ?Sized, T: DeserializeOwned>(
        &self,
        path: &str,
        body: &B,
    ) -> HostResult<HttpResponse<T>> {
        self.body_request(Method::PUT, path, body).await
    }

    async fn body_request<B: Serialize + ?Sized, T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        body: &B,
    ) -> HostResult<HttpResponse<T>> {
        let json =
            serde_json::to_string(body).map_err(|e| HostError::Protocol(format!("encode: {e}")))?;
        match self.execute(method, path, Some(json), &[]).await? {
            Outcome::Ok { body, headers } => {
                let value = self.decode(&body)?;
                let etag = extract_etag(&headers);
                Ok(HttpResponse {
                    value,
                    etag,
                    headers,
                })
            }
            Outcome::NotModified(_) => unreachable!("no conditional header sent"),
        }
    }

    /// POST, ignoring any response body (204 / empty on success).
    pub async fn post_no_content<B: Serialize + ?Sized>(
        &self,
        path: &str,
        body: &B,
    ) -> HostResult<()> {
        let json =
            serde_json::to_string(body).map_err(|e| HostError::Protocol(format!("encode: {e}")))?;
        match self.execute(Method::POST, path, Some(json), &[]).await? {
            Outcome::Ok { .. } => Ok(()),
            Outcome::NotModified(_) => unreachable!("no conditional header sent"),
        }
    }

    /// DELETE, ignoring any response body (GitHub returns 204/empty on
    /// success for comment deletion etc).
    pub async fn delete(&self, path: &str) -> HostResult<()> {
        match self.execute(Method::DELETE, path, None, &[]).await? {
            Outcome::Ok { .. } => Ok(()),
            Outcome::NotModified(_) => unreachable!("no conditional header sent"),
        }
    }

    /// DELETE with a JSON body (GitHub's `requested_reviewers` endpoint
    /// requires one to say who to remove).
    pub async fn delete_with_body<B: Serialize + ?Sized>(
        &self,
        path: &str,
        body: &B,
    ) -> HostResult<()> {
        let json =
            serde_json::to_string(body).map_err(|e| HostError::Protocol(format!("encode: {e}")))?;
        match self.execute(Method::DELETE, path, Some(json), &[]).await? {
            Outcome::Ok { .. } => Ok(()),
            Outcome::NotModified(_) => unreachable!("no conditional header sent"),
        }
    }

    fn decode<T: DeserializeOwned>(&self, body: &str) -> HostResult<T> {
        serde_json::from_str(body)
            .map_err(|e| HostError::Protocol(self.redact(&format!("decode: {e}: {body}"))))
    }

    async fn execute(
        &self,
        method: Method,
        path: &str,
        body: Option<String>,
        extra_headers: &[(&str, String)],
    ) -> HostResult<Outcome> {
        if let Some(until) = self
            .rate
            .lock()
            .expect("rate lock")
            .preemptive_block(self.now())
        {
            return Err(HostError::RateLimited { reset_at: until });
        }

        let url = self.url_for(path)?;
        let mut attempt: u32 = 0;
        loop {
            let mut req = self
                .client
                .request(method.clone(), url.clone())
                .header("user-agent", &self.user_agent);
            if let Some(token) = self.token.token() {
                req = req.bearer_auth(token);
            }
            if method != Method::GET || body.is_some() {
                req = req.header("accept", &self.accept);
            }
            for (name, value) in extra_headers {
                req = req.header(*name, value.clone());
            }
            if let Some(b) = &body {
                req = req
                    .header("content-type", "application/json")
                    .body(b.clone());
            }

            tracing::debug!(method = %method, url = %url, attempt, "host-http request");

            match req.send().await {
                Ok(resp) => {
                    let status = resp.status();
                    let headers = resp.headers().clone();
                    self.rate.lock().expect("rate lock").observe(&headers);

                    if status == StatusCode::NOT_MODIFIED {
                        return Ok(Outcome::NotModified(headers));
                    }

                    if status.is_server_error() && attempt < self.retry.max_retries {
                        tracing::warn!(status = %status, attempt, "host-http retrying server error");
                        attempt += 1;
                        self.backoff(attempt).await;
                        continue;
                    }

                    if let Some(err) = self.classify(status, &headers) {
                        let text = resp.text().await.unwrap_or_default();
                        return Err(self.attach_body(err, &text));
                    }

                    if status.is_server_error() {
                        return Err(HostError::Network(format!(
                            "server error {status} after retries"
                        )));
                    }

                    let text = resp
                        .text()
                        .await
                        .map_err(|e| HostError::Network(self.redact(&e.to_string())))?;
                    return Ok(Outcome::Ok {
                        body: text,
                        headers,
                    });
                }
                Err(e) if attempt < self.retry.max_retries && is_retryable_send_error(&e) => {
                    tracing::warn!(error = %e, attempt, "host-http retrying network error");
                    attempt += 1;
                    self.backoff(attempt).await;
                }
                Err(e) => return Err(HostError::Network(self.redact(&e.to_string()))),
            }
        }
    }

    fn classify(&self, status: StatusCode, headers: &HeaderMap) -> Option<HostError> {
        match status {
            StatusCode::UNAUTHORIZED => Some(HostError::Auth),
            StatusCode::FORBIDDEN => {
                if is_rate_limited_403(headers) {
                    let reset_at = reset_at_from_headers(headers, self.now());
                    self.rate.lock().expect("rate lock").block_until(reset_at);
                    Some(HostError::RateLimited { reset_at })
                } else {
                    Some(HostError::Auth)
                }
            }
            StatusCode::TOO_MANY_REQUESTS => {
                let reset_at = reset_at_from_headers(headers, self.now());
                self.rate.lock().expect("rate lock").block_until(reset_at);
                Some(HostError::RateLimited { reset_at })
            }
            StatusCode::NOT_FOUND => Some(HostError::NotFound(String::new())),
            // 405: GitHub/GitLab's merge endpoints answer this when the PR
            // isn't currently mergeable (open conflicts, blocked, etc).
            StatusCode::CONFLICT | StatusCode::METHOD_NOT_ALLOWED => {
                Some(HostError::Conflict(String::new()))
            }
            StatusCode::UNPROCESSABLE_ENTITY | StatusCode::BAD_REQUEST => {
                Some(HostError::Validation(String::new()))
            }
            s if s.is_client_error() => Some(HostError::Protocol(format!("unexpected status {s}"))),
            _ => None,
        }
    }

    fn attach_body(&self, err: HostError, body: &str) -> HostError {
        let msg = self.redact(body);
        match err {
            HostError::NotFound(_) => HostError::NotFound(msg),
            HostError::Conflict(_) => HostError::Conflict(msg),
            HostError::Validation(_) => HostError::Validation(msg),
            HostError::Protocol(prefix) => HostError::Protocol(format!("{prefix}: {msg}")),
            other => other,
        }
    }

    async fn backoff(&self, attempt: u32) {
        let base = self.retry.base_delay.as_millis() as u64;
        let cap = self.retry.max_delay.as_millis() as u64;
        let exp = base.saturating_mul(1u64 << attempt.min(10)).min(cap.max(1));
        let jitter = rand::random_range(0..=(exp / 2 + 1));
        self.clock
            .sleep(Duration::from_millis(exp / 2 + jitter))
            .await;
    }
}

fn extract_etag(headers: &HeaderMap) -> Option<String> {
    headers
        .get(reqwest::header::ETAG)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
}

/// `reqwest::Error` has no status for connection-level failures (DNS,
/// timeout, connect refused) — those are the ones worth retrying. A
/// `error_for_status`-style error would carry a status and is handled by the
/// status branch instead, so this only sees transport failures.
fn is_retryable_send_error(e: &reqwest::Error) -> bool {
    e.is_timeout() || e.is_connect() || e.is_request()
}
