mod support;

use theodore_domain::{HostKind, PrRef, RepoRef};
use theodore_ports::{HostAdapter, HostError, NewPr};
use wiremock::matchers::{body_json, method, path, query_param};
use wiremock::{Mock, ResponseTemplate};

fn repo() -> RepoRef {
    RepoRef {
        host: HostKind::Github,
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

#[tokio::test]
async fn find_open_pr_returns_none_when_no_pr_has_that_head() {
    let s = support::servers().await;

    Mock::given(method("GET"))
        .and(path("/repos/acme/widgets/pulls"))
        .and(query_param("state", "open"))
        .and(query_param("head", "acme:feat/login"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([])))
        .expect(1)
        .mount(&s.rest)
        .await;

    let found = s.adapter.find_open_pr(&repo(), "feat/login").await.unwrap();
    assert_eq!(found, None);
}

#[tokio::test]
async fn find_open_pr_returns_the_open_pr_for_that_head() {
    let s = support::servers().await;

    Mock::given(method("GET"))
        .and(path("/repos/acme/widgets/pulls"))
        .and(query_param("state", "open"))
        .and(query_param("head", "acme:feat/login"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
            { "number": 57, "node_id": "PR_kwDOAbc", "head": { "ref": "feat/login" } }
        ])))
        .mount(&s.rest)
        .await;

    let found = s.adapter.find_open_pr(&repo(), "feat/login").await.unwrap();
    assert_eq!(
        found,
        Some(PrRef {
            repo: repo(),
            number: 57,
            host_id: Some("PR_kwDOAbc".into()),
        })
    );
}

#[tokio::test]
async fn create_pr_posts_title_body_head_base_and_draft() {
    let s = support::servers().await;

    Mock::given(method("POST"))
        .and(path("/repos/acme/widgets/pulls"))
        .and(body_json(serde_json::json!({
            "title": "Add login",
            "body": "Adds the login form.",
            "head": "feat/login",
            "base": "main",
            "draft": true
        })))
        .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
            "number": 58,
            "node_id": "PR_kwDOdef",
            "draft": true,
            "html_url": "https://github.com/acme/widgets/pull/58"
        })))
        .expect(1)
        .mount(&s.rest)
        .await;

    let pr = s.adapter.create_pr(&repo(), &new_pr(true)).await.unwrap();
    assert_eq!(
        pr,
        PrRef {
            repo: repo(),
            number: 58,
            host_id: Some("PR_kwDOdef".into()),
        }
    );
    assert_eq!(pr.id().0, "github:acme/widgets#58");
}

#[tokio::test]
async fn create_pr_sends_draft_false_for_a_ready_pr() {
    let s = support::servers().await;

    Mock::given(method("POST"))
        .and(path("/repos/acme/widgets/pulls"))
        .and(body_json(serde_json::json!({
            "title": "Add login",
            "body": "Adds the login form.",
            "head": "feat/login",
            "base": "main",
            "draft": false
        })))
        .respond_with(
            ResponseTemplate::new(201)
                .set_body_json(serde_json::json!({ "number": 59, "node_id": "PR_x" })),
        )
        .expect(1)
        .mount(&s.rest)
        .await;

    let pr = s.adapter.create_pr(&repo(), &new_pr(false)).await.unwrap();
    assert_eq!(pr.number, 59);
}

#[tokio::test]
async fn create_pr_maps_already_exists_to_conflict() {
    let s = support::servers().await;

    Mock::given(method("POST"))
        .and(path("/repos/acme/widgets/pulls"))
        .respond_with(ResponseTemplate::new(422).set_body_json(serde_json::json!({
            "message": "Validation Failed",
            "errors": [{
                "resource": "PullRequest",
                "code": "custom",
                "message": "A pull request already exists for acme:feat/login."
            }],
            "documentation_url": "https://docs.github.com/rest/pulls/pulls#create-a-pull-request"
        })))
        .mount(&s.rest)
        .await;

    let err = s
        .adapter
        .create_pr(&repo(), &new_pr(false))
        .await
        .unwrap_err();
    assert!(matches!(err, HostError::Conflict(_)), "got {err:?}");
}

#[tokio::test]
async fn create_pr_keeps_other_422s_as_validation() {
    let s = support::servers().await;

    Mock::given(method("POST"))
        .and(path("/repos/acme/widgets/pulls"))
        .respond_with(ResponseTemplate::new(422).set_body_json(serde_json::json!({
            "message": "Validation Failed",
            "errors": [{ "resource": "PullRequest", "field": "base", "code": "invalid" }]
        })))
        .mount(&s.rest)
        .await;

    let err = s
        .adapter
        .create_pr(&repo(), &new_pr(false))
        .await
        .unwrap_err();
    assert!(matches!(err, HostError::Validation(_)), "got {err:?}");
}
