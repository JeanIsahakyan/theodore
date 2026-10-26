//! Offset pagination for GitLab's REST list endpoints: `page`/`per_page`
//! query params in, `x-next-page` header out (plan §6.9 "pagination for
//! threads/comments/files" — GitLab's analogue of GitHub's GraphQL cursors).

use reqwest::header::HeaderMap;
use theodore_ports::HostResult;

/// `x-next-page` is present and non-empty while there is another page, and
/// either absent or empty (`""`) on the last one.
pub(crate) fn next_page(headers: &HeaderMap) -> Option<u32> {
    headers
        .get("x-next-page")?
        .to_str()
        .ok()
        .filter(|s| !s.is_empty())?
        .parse()
        .ok()
}

/// Repeatedly calls `fetch_page(page)` starting at `1`, collecting every
/// item, until the response carries no `x-next-page`.
pub(crate) async fn paginate_all<T, F, Fut>(mut fetch_page: F) -> HostResult<Vec<T>>
where
    F: FnMut(u32) -> Fut,
    Fut: std::future::Future<Output = HostResult<(Vec<T>, HeaderMap)>>,
{
    let mut all = Vec::new();
    let mut page = 1;
    loop {
        let (items, headers) = fetch_page(page).await?;
        all.extend(items);
        match next_page(&headers) {
            Some(next) => page = next,
            None => break,
        }
    }
    Ok(all)
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::HeaderValue;

    fn headers(next: Option<&str>) -> HeaderMap {
        let mut h = HeaderMap::new();
        if let Some(n) = next {
            h.insert("x-next-page", HeaderValue::from_str(n).unwrap());
        }
        h
    }

    #[test]
    fn next_page_parses_present_header() {
        assert_eq!(next_page(&headers(Some("2"))), Some(2));
    }

    #[test]
    fn next_page_is_none_when_absent_or_empty() {
        assert_eq!(next_page(&headers(None)), None);
        assert_eq!(next_page(&headers(Some(""))), None);
    }

    #[tokio::test]
    async fn collects_every_page() {
        let pages: Vec<Vec<i32>> = vec![vec![1, 2], vec![3, 4], vec![5]];
        let mut remaining = pages.into_iter();
        let seen_pages = std::sync::Mutex::new(Vec::<u32>::new());

        let result = paginate_all(|page: u32| {
            seen_pages.lock().unwrap().push(page);
            let chunk = remaining.next();
            async move {
                match chunk {
                    Some(items) => Ok((items, headers(Some(&(page + 1).to_string())))),
                    None => Ok((vec![], headers(None))),
                }
            }
        })
        .await
        .unwrap();

        assert_eq!(result, vec![1, 2, 3, 4, 5]);
        assert_eq!(*seen_pages.lock().unwrap(), vec![1, 2, 3, 4]);
    }

    #[tokio::test]
    async fn stops_on_first_page_without_next_page_header() {
        let result: Vec<i32> = paginate_all(|_page| async { Ok((vec![1, 2], headers(None))) })
            .await
            .unwrap();
        assert_eq!(result, vec![1, 2]);
    }
}
