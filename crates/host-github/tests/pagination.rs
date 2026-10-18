//! Multi-page `files`/`reviewThreads` connections (plan §6: "pagination for
//! threads/comments/files").

mod support;

use theodore_domain::{HostKind, PrRef, RepoRef};
use theodore_ports::{Fetched, HostAdapter};
use wiremock::matchers::{body_string_contains, method, path};
use wiremock::{Mock, ResponseTemplate};

fn pr() -> PrRef {
    PrRef {
        repo: RepoRef {
            host: HostKind::Github,
            owner: "acme".into(),
            name: "widgets".into(),
        },
        number: 42,
        host_id: None,
    }
}

#[tokio::test]
async fn files_and_threads_follow_cursors_across_pages() {
    let s = support::servers().await;

    Mock::given(method("GET"))
        .and(path("/repos/acme/widgets/pulls/42"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("etag", "\"e\"")
                .set_body_json(serde_json::json!({})),
        )
        .mount(&s.rest)
        .await;

    Mock::given(method("POST"))
        .and(path("/"))
        .and(body_string_contains("statusCheckRollup"))
        .respond_with(ResponseTemplate::new(200).set_body_json(support::fixture("pr_core.json")))
        .mount(&s.graphql)
        .await;

    // Page 1 has no `after`; page 2 is requested with the cursor page 1 returned.
    Mock::given(method("POST"))
        .and(path("/"))
        .and(body_string_contains("viewerViewedState"))
        .and(body_string_contains("\"after\":null"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(support::fixture("pr_files_page1.json")),
        )
        .mount(&s.graphql)
        .await;
    Mock::given(method("POST"))
        .and(path("/"))
        .and(body_string_contains("viewerViewedState"))
        .and(body_string_contains("files-cursor-1"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(support::fixture("pr_files_page2.json")),
        )
        .mount(&s.graphql)
        .await;

    Mock::given(method("POST"))
        .and(path("/"))
        .and(body_string_contains("reviewThreads"))
        .and(body_string_contains("\"after\":null"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(support::fixture("pr_threads_page1.json")),
        )
        .mount(&s.graphql)
        .await;
    Mock::given(method("POST"))
        .and(path("/"))
        .and(body_string_contains("reviewThreads"))
        .and(body_string_contains("threads-cursor-1"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(support::fixture("pr_threads_page2.json")),
        )
        .mount(&s.graphql)
        .await;

    let Fetched::Modified { value: detail, .. } = s.adapter.get_pr(&pr(), None).await.unwrap()
    else {
        panic!("expected Modified");
    };

    let mut paths: Vec<_> = detail.viewed.iter().map(|v| v.path.clone()).collect();
    paths.sort();
    assert_eq!(
        paths,
        vec!["src/lib.rs".to_string(), "src/main.rs".to_string()]
    );

    let mut thread_ids: Vec<_> = detail
        .threads
        .iter()
        .map(|t| t.id.as_str().to_string())
        .collect();
    thread_ids.sort();
    assert_eq!(
        thread_ids,
        vec!["thread_1".to_string(), "thread_2".to_string()]
    );
}
