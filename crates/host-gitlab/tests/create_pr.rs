mod support;

use theodore_domain::{HostKind, PrRef, RepoRef};
use theodore_ports::{HostAdapter, HostError, NewPr};
use wiremock::matchers::{body_json, method, path, query_param};
use wiremock::{Mock, ResponseTemplate};

fn repo() -> RepoRef {
    RepoRef {
        host: HostKind::Gitlab,
        owner: "acme".into(),
        name: "widgets".into(),
    }
}

fn new_pr(draft: bool) -> NewPr {
    NewPr {
        head: "feat/login".into(),
        base: "main".into(),
        title: "Add login".into(),
        body: "Adds the login form.".into(),
        draft,
    }
}

fn mr_json(iid: u64, title: &str) -> serde_json::Value {
    serde_json::json!({
        "iid": iid,
        "project_id": 7,
        "title": title,
        "state": "opened",
        "web_url": format!("https://gitlab.com/acme/widgets/-/merge_requests/{iid}"),
        "source_branch": "feat/login",
        "target_branch": "main",
        "sha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "author": { "id": 1, "username": "alice" },
        "created_at": "2023-12-31T00:00:00.000Z",
        "updated_at": "2024-01-01T00:00:00.000Z"
    })
}

fn expected(iid: u64) -> PrRef {
    PrRef {
        repo: repo(),
        number: iid,
        host_id: Some("7".into()),
    }
}

#[tokio::test]
async fn find_open_pr_returns_none_when_no_mr_has_that_source_branch() {
    let s = support::servers().await;

    Mock::given(method("GET"))
        .and(path("/projects/acme%2Fwidgets/merge_requests"))
        .and(query_param("state", "opened"))
        .and(query_param("source_branch", "feat/login"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([])))
        .expect(1)
        .mount(&s.api)
        .await;

    let found = s.adapter.find_open_pr(&repo(), "feat/login").await.unwrap();
    assert_eq!(found, None);
}

#[tokio::test]
async fn find_open_pr_returns_the_open_mr_for_that_source_branch() {
    let s = support::servers().await;

    Mock::given(method("GET"))
        .and(path("/projects/acme%2Fwidgets/merge_requests"))
        .and(query_param("state", "opened"))
        .and(query_param("source_branch", "feat/login"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(serde_json::json!([mr_json(12, "Add login")])),
        )
        .mount(&s.api)
        .await;

    let found = s.adapter.find_open_pr(&repo(), "feat/login").await.unwrap();
    assert_eq!(found, Some(expected(12)));
}

#[tokio::test]
async fn create_pr_posts_branches_title_and_description() {
    let s = support::servers().await;

    Mock::given(method("POST"))
        .and(path("/projects/acme%2Fwidgets/merge_requests"))
        .and(body_json(serde_json::json!({
            "source_branch": "feat/login",
            "target_branch": "main",
            "title": "Add login",
            "description": "Adds the login form."
        })))
        .respond_with(ResponseTemplate::new(201).set_body_json(mr_json(13, "Add login")))
        .expect(1)
        .mount(&s.api)
        .await;

    let pr = s.adapter.create_pr(&repo(), &new_pr(false)).await.unwrap();
    assert_eq!(pr, expected(13));
    assert_eq!(pr.id().0, "gitlab:acme/widgets#13");
}

#[tokio::test]
async fn create_pr_opens_a_draft_with_a_draft_title_prefix() {
    let s = support::servers().await;

    Mock::given(method("POST"))
        .and(path("/projects/acme%2Fwidgets/merge_requests"))
        .and(body_json(serde_json::json!({
            "source_branch": "feat/login",
            "target_branch": "main",
            "title": "Draft: Add login",
            "description": "Adds the login form."
        })))
        .respond_with(ResponseTemplate::new(201).set_body_json(mr_json(14, "Draft: Add login")))
        .expect(1)
        .mount(&s.api)
        .await;

    let pr = s.adapter.create_pr(&repo(), &new_pr(true)).await.unwrap();
    assert_eq!(pr, expected(14));
}

#[tokio::test]
async fn create_pr_maps_an_existing_mr_to_conflict() {
    let s = support::servers().await;

    Mock::given(method("POST"))
        .and(path("/projects/acme%2Fwidgets/merge_requests"))
        .respond_with(ResponseTemplate::new(409).set_body_json(serde_json::json!({
            "message": ["Another open merge request already exists for this source branch: !12"]
        })))
        .mount(&s.api)
        .await;

    let err = s
        .adapter
        .create_pr(&repo(), &new_pr(false))
        .await
        .unwrap_err();
    assert!(matches!(err, HostError::Conflict(_)), "got {err:?}");
}
