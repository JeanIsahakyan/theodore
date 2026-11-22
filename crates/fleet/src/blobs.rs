//! The cloud blob store over HTTP (docs/fleet.md "Files (blobs)"): the
//! ciphertext chunks of a file, under a random blob id, Bearer = the
//! account's access token.
//!
//! ```text
//! PUT    <cloud>/v1/fleet/blobs/{blob_id}/{i}   body = chunk, x-theodore-chunks: N ─▶ 204
//! GET    <cloud>/v1/fleet/blobs/{blob_id}/{i}   ─▶ 200 bytes
//! DELETE <cloud>/v1/fleet/blobs/{blob_id}       ─▶ 204
//! errors {code}: fleet.blob_not_found 404, fleet.too_large 413, fleet.quota 429,
//!                fleet.unauthorized 401
//! ```
//!
//! Logs carry the blob id's length and the status only: never the token,
//! the bytes or a file name.

use std::time::Duration;

use reqwest::StatusCode;
use theodore_fleet_protocol::blob::{CHUNK_BYTES, TAG_BYTES};
use theodore_ports::fleet::{BlobAccess, BlobStoreError};
use url::Url;

/// `x-theodore-chunks`: how many chunks the blob has, on every `PUT`.
pub const CHUNKS_HEADER: &str = "x-theodore-chunks";
/// One chunk request, at most (a 4 MiB chunk on a slow link).
const TIMEOUT: Duration = Duration::from_secs(120);

/// The route for chunk `i` of `blob_id`, or the blob itself (`None`).
pub fn blob_url(cloud_url: &str, blob_id: &str, i: Option<u32>) -> Result<Url, BlobStoreError> {
    let mut url = Url::parse(cloud_url.trim())
        .map_err(|e| BlobStoreError::Other(format!("cloud URL isn't a URL: {e}")))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(BlobStoreError::Other(
            "cloud URL scheme isn't http(s)".into(),
        ));
    }
    let base = url.path().trim_end_matches('/').to_string();
    let path = match i {
        Some(i) => format!("{base}/v1/fleet/blobs/{blob_id}/{i}"),
        None => format!("{base}/v1/fleet/blobs/{blob_id}"),
    };
    url.set_path(&path);
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

pub(crate) struct Blobs {
    http: reqwest::Client,
}

impl Blobs {
    pub(crate) fn new() -> Self {
        let http = reqwest::Client::builder()
            .user_agent("theodore")
            .timeout(TIMEOUT)
            .build()
            .unwrap_or_default();
        Blobs { http }
    }

    fn bearer(access: &BlobAccess) -> String {
        format!("Bearer {}", access.access_token)
    }

    pub(crate) async fn put(
        &self,
        access: &BlobAccess,
        blob_id: &str,
        i: u32,
        chunks: u32,
        chunk: Vec<u8>,
    ) -> Result<(), BlobStoreError> {
        if chunk.len() > CHUNK_BYTES + TAG_BYTES {
            return Err(BlobStoreError::TooLarge);
        }
        let url = blob_url(&access.cloud_url, blob_id, Some(i))?;
        let resp = self
            .http
            .put(url)
            .header(reqwest::header::AUTHORIZATION, Self::bearer(access))
            .header(CHUNKS_HEADER, chunks.to_string())
            .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
            .body(chunk)
            .send()
            .await
            .map_err(network)?;
        let status = resp.status();
        tracing::debug!(%status, i, chunks, "fleet blob: put");
        if status.is_success() {
            return Ok(());
        }
        Err(refused(status, resp).await)
    }

    pub(crate) async fn get(
        &self,
        access: &BlobAccess,
        blob_id: &str,
        i: u32,
    ) -> Result<Vec<u8>, BlobStoreError> {
        let url = blob_url(&access.cloud_url, blob_id, Some(i))?;
        let resp = self
            .http
            .get(url)
            .header(reqwest::header::AUTHORIZATION, Self::bearer(access))
            .send()
            .await
            .map_err(network)?;
        let status = resp.status();
        tracing::debug!(%status, i, "fleet blob: get");
        if !status.is_success() {
            return Err(refused(status, resp).await);
        }
        // Bounded before reading: a chunk is at most its share plus the tag.
        if resp
            .content_length()
            .is_some_and(|n| n > (CHUNK_BYTES + TAG_BYTES) as u64)
        {
            return Err(BlobStoreError::TooLarge);
        }
        let bytes = resp.bytes().await.map_err(network)?;
        if bytes.len() > CHUNK_BYTES + TAG_BYTES {
            return Err(BlobStoreError::TooLarge);
        }
        Ok(bytes.to_vec())
    }

    pub(crate) async fn delete(
        &self,
        access: &BlobAccess,
        blob_id: &str,
    ) -> Result<(), BlobStoreError> {
        let url = blob_url(&access.cloud_url, blob_id, None)?;
        let resp = self
            .http
            .delete(url)
            .header(reqwest::header::AUTHORIZATION, Self::bearer(access))
            .send()
            .await
            .map_err(network)?;
        let status = resp.status();
        tracing::debug!(%status, "fleet blob: delete");
        if status.is_success() || status == StatusCode::NOT_FOUND {
            return Ok(());
        }
        Err(refused(status, resp).await)
    }
}

fn network(e: reqwest::Error) -> BlobStoreError {
    // reqwest's Display may carry the URL (never the token); keep the kind.
    let kind = if e.is_timeout() {
        "timed out"
    } else if e.is_connect() {
        "couldn't connect"
    } else if e.is_body() || e.is_decode() {
        "unreadable body"
    } else {
        "request failed"
    };
    BlobStoreError::Other(kind.to_string())
}

/// The error of a non-2xx answer: the JSON `{code}` when it's one the
/// contract names, else by status.
async fn refused(status: StatusCode, resp: reqwest::Response) -> BlobStoreError {
    let code = resp
        .bytes()
        .await
        .ok()
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .and_then(|v| v.get("code").and_then(|c| c.as_str()).map(str::to_string));
    by_status(status.as_u16(), code.as_deref())
}

/// The contract's error for an HTTP status and the body's `code`.
pub fn by_status(status: u16, code: Option<&str>) -> BlobStoreError {
    match (status, code) {
        (_, Some("fleet.blob_not_found")) | (404, _) => BlobStoreError::NotFound,
        (_, Some("fleet.too_large")) | (413, _) => BlobStoreError::TooLarge,
        (_, Some("fleet.quota")) | (429, _) => BlobStoreError::Quota,
        (_, Some("fleet.unauthorized")) | (401, _) | (403, _) => BlobStoreError::Unauthorized,
        (s, Some(c)) => BlobStoreError::Other(format!("{s} {c}")),
        (s, None) => BlobStoreError::Other(format!("HTTP {s}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_keep_the_cloud_base_path() {
        let u = blob_url("https://cloud.example", "ab".repeat(16).as_str(), Some(2)).unwrap();
        assert_eq!(
            u.as_str(),
            format!("https://cloud.example/v1/fleet/blobs/{}/2", "ab".repeat(16))
        );
        let u = blob_url("https://x.example/base/?q=1", "cd", None).unwrap();
        assert_eq!(u.as_str(), "https://x.example/base/v1/fleet/blobs/cd");
        assert!(blob_url("ftp://x", "cd", None).is_err());
        assert!(blob_url("not a url", "cd", None).is_err());
    }

    #[test]
    fn statuses_map_to_the_contract_codes() {
        assert_eq!(by_status(404, None), BlobStoreError::NotFound);
        assert_eq!(
            by_status(400, Some("fleet.blob_not_found")),
            BlobStoreError::NotFound
        );
        assert_eq!(by_status(413, None), BlobStoreError::TooLarge);
        assert_eq!(by_status(429, Some("fleet.quota")), BlobStoreError::Quota);
        assert_eq!(by_status(401, None), BlobStoreError::Unauthorized);
        assert_eq!(by_status(403, None), BlobStoreError::Unauthorized);
        assert_eq!(
            by_status(500, Some("fleet.internal")),
            BlobStoreError::Other("500 fleet.internal".into())
        );
        assert_eq!(
            by_status(502, None),
            BlobStoreError::Other("HTTP 502".into())
        );
    }
}
