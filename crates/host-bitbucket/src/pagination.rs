//! Bitbucket's own pagination style: each page's body carries `next`, a
//! ready-to-fetch absolute URL (already encoding the following page's
//! cursor), rather than GitLab's `x-next-page` header (plan §6.9).

use serde::Deserialize;
use serde::de::DeserializeOwned;
use theodore_ports::HostResult;

use crate::http::BbHttp;

#[derive(Debug, Deserialize)]
#[serde(bound(deserialize = "T: serde::de::DeserializeOwned"))]
pub(crate) struct Page<T> {
    #[serde(default)]
    pub values: Vec<T>,
    #[serde(default)]
    pub next: Option<String>,
}

/// Fetches `first_path`, then follows `next` until a page carries none,
/// collecting every `values` entry along the way.
pub(crate) async fn paginate_all<T: DeserializeOwned>(
    http: &BbHttp,
    first_path: &str,
) -> HostResult<Vec<T>> {
    let mut all = Vec::new();
    let mut page: Page<T> = http.get(first_path).await?;
    loop {
        all.extend(page.values);
        match page.next {
            Some(next) => page = http.get_absolute(&next).await?,
            None => break,
        }
    }
    Ok(all)
}
