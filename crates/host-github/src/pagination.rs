//! Cursor pagination for GraphQL connections (plan §6: "pagination for
//! threads/comments/files").

use serde::Deserialize;
use theodore_ports::HostResult;

#[derive(Debug, Clone, Default, Deserialize)]
pub(crate) struct PageInfo {
    #[serde(rename = "hasNextPage")]
    pub has_next_page: bool,
    #[serde(rename = "endCursor")]
    pub end_cursor: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct Connection<N> {
    pub nodes: Vec<Option<N>>,
    /// Absent when the query selects only the first page (`first: 100`).
    #[serde(rename = "pageInfo", default)]
    pub page_info: PageInfo,
}

impl<N> Connection<N> {
    pub(crate) fn into_nodes(self) -> Vec<N> {
        self.nodes.into_iter().flatten().collect()
    }

    pub(crate) fn iter(&self) -> impl Iterator<Item = &N> {
        self.nodes.iter().filter_map(|o| o.as_ref())
    }
}

/// Repeatedly calls `fetch_page(after_cursor)` until the connection reports
/// no more pages, collecting every node along the way.
pub(crate) async fn paginate_all<N, F, Fut>(mut fetch_page: F) -> HostResult<Vec<N>>
where
    F: FnMut(Option<String>) -> Fut,
    Fut: std::future::Future<Output = HostResult<Connection<N>>>,
{
    let mut all = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let page = fetch_page(cursor).await?;
        let has_next = page.page_info.has_next_page;
        let next_cursor = page.page_info.end_cursor.clone();
        all.extend(page.into_nodes());
        if !has_next {
            break;
        }
        match next_cursor {
            Some(c) => cursor = Some(c),
            None => break,
        }
    }
    Ok(all)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn collects_every_page() {
        let pages: Vec<Vec<i32>> = vec![vec![1, 2], vec![3, 4], vec![5]];
        let mut remaining = pages.into_iter();
        let seen_cursors = std::sync::Mutex::new(Vec::<Option<String>>::new());

        let result = paginate_all(|cursor: Option<String>| {
            seen_cursors.lock().unwrap().push(cursor);
            let chunk = remaining.next();
            async move {
                match chunk {
                    Some(items) => Ok(Connection {
                        nodes: items.into_iter().map(Some).collect(),
                        page_info: PageInfo {
                            has_next_page: true,
                            end_cursor: Some("next".into()),
                        },
                    }),
                    None => Ok(Connection {
                        nodes: vec![],
                        page_info: PageInfo {
                            has_next_page: false,
                            end_cursor: None,
                        },
                    }),
                }
            }
        })
        .await
        .unwrap();

        assert_eq!(result, vec![1, 2, 3, 4, 5]);
        assert_eq!(seen_cursors.lock().unwrap().len(), 4);
    }

    #[tokio::test]
    async fn stops_when_has_next_page_is_false_even_with_a_cursor() {
        let result: Vec<i32> = paginate_all(|_cursor| async {
            Ok(Connection {
                nodes: vec![Some(1)],
                page_info: PageInfo {
                    has_next_page: false,
                    end_cursor: Some("ignored".into()),
                },
            })
        })
        .await
        .unwrap();
        assert_eq!(result, vec![1]);
    }

    #[tokio::test]
    async fn skips_null_nodes() {
        let result: Vec<i32> = paginate_all(|_cursor| async {
            Ok(Connection {
                nodes: vec![Some(1), None, Some(2)],
                page_info: PageInfo {
                    has_next_page: false,
                    end_cursor: None,
                },
            })
        })
        .await
        .unwrap();
        assert_eq!(result, vec![1, 2]);
    }
}

#[cfg(test)]
mod page_info_tests {
    use super::*;

    #[test]
    fn connection_without_page_info_decodes() {
        let c: Connection<serde_json::Value> =
            serde_json::from_str(r#"{"nodes":[{"name":"bug"}]}"#).expect("decode");
        assert_eq!(c.into_nodes().len(), 1);
    }
}
