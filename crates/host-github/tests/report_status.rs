//! "My reports": a report issue's state and the release that shipped its fix
//! (`IssueTracker::issue_status`, `first_release_with`).

mod support;

use theodore_ports::{HostError, IssueCloser, IssueTracker};
use wiremock::matchers::{body_string_contains, method, path, query_param};
use wiremock::{Mock, ResponseTemplate};

fn issue(state: &str, reason: Option<&str>, closer: serde_json::Value) -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_json(serde_json::json!({
        "data": { "repository": { "issue": {
            "number": 42,
            "title": "Diff pane is blank",
            "url": "https://github.com/acme/theodore/issues/42",
            "state": state,
            "stateReason": reason,
            "updatedAt": "2026-11-01T10:00:00Z",
            "closedAt": if state == "CLOSED" { serde_json::json!("2026-11-01T09:00:00Z") } else { serde_json::Value::Null },
            "author": { "login": "ada" },
            "comments": { "totalCount": 2, "nodes": [{ "author": { "login": "maintainer" } }] },
            "timelineItems": { "nodes": [{ "closer": closer }] }
        } } }
    }))
}

#[tokio::test]
async fn an_open_issue_reads_its_comments_and_no_closer() {
    let s = support::servers().await;
    Mock::given(method("POST"))
        .and(path("/"))
        .and(body_string_contains("\"number\":42"))
        .respond_with(issue("OPEN", None, serde_json::Value::Null))
        .mount(&s.graphql)
        .await;

    let got = s
        .adapter
        .issue_status("acme", "theodore", 42)
        .await
        .unwrap();
    assert!(got.open);
    assert_eq!(got.close_reason, None);
    assert_eq!(got.comments, 2);
    assert_eq!(got.author.as_deref(), Some("ada"));
    assert_eq!(got.last_commenter.as_deref(), Some("maintainer"));
    assert_eq!(got.closed_by, None);
    assert!(got.updated_at > 0);
}

#[tokio::test]
async fn closed_by_a_pr_names_it_and_its_merge_commit() {
    let s = support::servers().await;
    Mock::given(method("POST"))
        .and(path("/"))
        .respond_with(issue(
            "CLOSED",
            Some("COMPLETED"),
            serde_json::json!({
                "__typename": "PullRequest",
                "number": 57,
                "url": "https://github.com/acme/theodore/pull/57",
                "mergeCommit": { "oid": "abc123" }
            }),
        ))
        .mount(&s.graphql)
        .await;

    let got = s
        .adapter
        .issue_status("acme", "theodore", 42)
        .await
        .unwrap();
    assert!(!got.open);
    assert_eq!(got.close_reason.as_deref(), Some("completed"));
    assert_eq!(
        got.closed_by,
        Some(IssueCloser {
            pr: Some(57),
            pr_url: Some("https://github.com/acme/theodore/pull/57".into()),
            sha: Some("abc123".into()),
        })
    );
}

#[tokio::test]
async fn closed_by_a_commit_keeps_its_sha() {
    let s = support::servers().await;
    Mock::given(method("POST"))
        .and(path("/"))
        .respond_with(issue(
            "CLOSED",
            Some("COMPLETED"),
            serde_json::json!({ "__typename": "Commit", "oid": "def456" }),
        ))
        .mount(&s.graphql)
        .await;

    let got = s
        .adapter
        .issue_status("acme", "theodore", 42)
        .await
        .unwrap();
    let closer = got.closed_by.unwrap();
    assert_eq!(closer.pr, None);
    assert_eq!(closer.sha.as_deref(), Some("def456"));
}

#[tokio::test]
async fn a_missing_issue_is_not_found() {
    let s = support::servers().await;
    Mock::given(method("POST"))
        .and(path("/"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "data": { "repository": { "issue": null } }
        })))
        .mount(&s.graphql)
        .await;

    let e = s
        .adapter
        .issue_status("acme", "theodore", 42)
        .await
        .unwrap_err();
    assert!(matches!(e, HostError::NotFound(_)), "{e:?}");
}

async fn releases(s: &support::Servers, tags: &[&str]) {
    // Newest first, as GitHub lists them; a draft and a channel tag mixed in.
    let mut list: Vec<serde_json::Value> = tags
        .iter()
        .enumerate()
        .map(|(i, t)| {
            serde_json::json!({
                "tag_name": t,
                "draft": false,
                "prerelease": false,
                "published_at": format!("2026-10-{:02}T00:00:00Z", i + 1)
            })
        })
        .rev()
        .collect();
    list.push(serde_json::json!({ "tag_name": "v9.9.9", "draft": true, "published_at": null }));
    list.push(serde_json::json!({
        "tag_name": "channel-beta", "draft": false, "prerelease": true,
        "published_at": "2026-10-30T00:00:00Z"
    }));
    Mock::given(method("GET"))
        .and(path("/repos/acme/theodore/releases"))
        .respond_with(ResponseTemplate::new(200).set_body_json(list))
        .mount(&s.rest)
        .await;
}

async fn compare(s: &support::Servers, tag: &str, status: &str) {
    Mock::given(method("GET"))
        .and(path(format!("/repos/acme/theodore/compare/abc123...{tag}")))
        .and(query_param("per_page", "1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "status": status, "ahead_by": 1, "behind_by": 0
        })))
        .mount(&s.rest)
        .await;
}

#[tokio::test]
async fn the_first_release_containing_the_fix_is_found() {
    let s = support::servers().await;
    releases(&s, &["v0.1.5", "v0.1.6", "v0.1.7", "v0.1.8"]).await;
    compare(&s, "v0.1.5", "behind").await;
    compare(&s, "v0.1.6", "diverged").await;
    compare(&s, "v0.1.7", "ahead").await;
    compare(&s, "v0.1.8", "ahead").await;

    let got = s
        .adapter
        .first_release_with("acme", "theodore", "abc123")
        .await
        .unwrap();
    assert_eq!(got.as_deref(), Some("v0.1.7"));
}

#[tokio::test]
async fn no_release_yet_asks_only_the_newest() {
    let s = support::servers().await;
    releases(&s, &["v0.1.5", "v0.1.6"]).await;
    Mock::given(method("GET"))
        .and(path("/repos/acme/theodore/compare/abc123...v0.1.6"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "status": "diverged"
        })))
        .expect(1)
        .mount(&s.rest)
        .await;
    Mock::given(method("GET"))
        .and(path("/repos/acme/theodore/compare/abc123...v0.1.5"))
        .respond_with(ResponseTemplate::new(200))
        .expect(0)
        .mount(&s.rest)
        .await;

    let got = s
        .adapter
        .first_release_with("acme", "theodore", "abc123")
        .await
        .unwrap();
    assert_eq!(got, None);
}

#[tokio::test]
async fn a_commit_the_repo_lacks_is_in_no_release() {
    let s = support::servers().await;
    releases(&s, &["v0.1.5"]).await;
    Mock::given(method("GET"))
        .and(path("/repos/acme/theodore/compare/abc123...v0.1.5"))
        .respond_with(ResponseTemplate::new(404).set_body_json(serde_json::json!({
            "message": "Not Found"
        })))
        .mount(&s.rest)
        .await;

    let got = s
        .adapter
        .first_release_with("acme", "theodore", "abc123")
        .await
        .unwrap();
    assert_eq!(got, None);
}
