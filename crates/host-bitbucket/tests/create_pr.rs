mod support;

use theodore_domain::{HostKind, PrRef, RepoRef};
use theodore_ports::{HostAdapter, HostError, NewPr};
use wiremock::matchers::{body_json, method, path, query_param};
use wiremock::{Mock, ResponseTemplate};

fn repo() -> RepoRef {
    RepoRef {
        host: HostKind::Bitbucket,
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

/// The `pull_request.json` fixture, re-pointed at `source_repo`'s
/// `feat/login` branch with the given id.
fn pr_json(id: u64, source_repo: &str) -> serde_json::Value {
    let mut pr = support::fixture("pull_request.json");
    pr["id"] = id.into();
    pr["source"]["branch"]["name"] = "feat/login".into();
    pr["source"]["repository"]["full_name"] = source_repo.into();
    pr
}

const FIND_Q: &str = "source.branch.name=\"feat/login\" AND state=\"OPEN\"";

#[tokio::test]
async fn find_open_pr_returns_none_when_no_pr_has_that_source_branch() {
    let s = support::servers().await;

    Mock::given(method("GET"))
        .and(path("/repositories/acme/widgets/pullrequests"))
        .and(query_param("state", "OPEN"))
        .and(query_param("q", FIND_Q))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "values": []
        })))
        .expect(1)
        .mount(&s.api)
        .await;

    let found = s.adapter.find_open_pr(&repo(), "feat/login").await.unwrap();
    assert_eq!(found, None);
}

#[tokio::test]
async fn find_open_pr_returns_the_same_repo_pr_for_that_branch() {
    let s = support::servers().await;

    Mock::given(method("GET"))
        .and(path("/repositories/acme/widgets/pullrequests"))
        .and(query_param("state", "OPEN"))
        .and(query_param("q", FIND_Q))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "values": [pr_json(70, "someone/widgets-fork"), pr_json(71, "acme/widgets")]
        })))
        .mount(&s.api)
        .await;

    let found = s.adapter.find_open_pr(&repo(), "feat/login").await.unwrap();
    assert_eq!(
        found,
        Some(PrRef {
            repo: repo(),
            number: 71,
            host_id: None,
        })
    );
}

#[tokio::test]
async fn create_pr_posts_title_description_branches_and_draft() {
    let s = support::servers().await;

    Mock::given(method("POST"))
        .and(path("/repositories/acme/widgets/pullrequests"))
        .and(body_json(serde_json::json!({
            "title": "Add login",
            "description": "Adds the login form.",
            "source": { "branch": { "name": "feat/login" } },
            "destination": { "branch": { "name": "main" } },
            "draft": true
        })))
        .respond_with(ResponseTemplate::new(201).set_body_json(pr_json(72, "acme/widgets")))
        .expect(1)
        .mount(&s.api)
        .await;

    let pr = s.adapter.create_pr(&repo(), &new_pr(true)).await.unwrap();
    assert_eq!(
        pr,
        PrRef {
            repo: repo(),
            number: 72,
            host_id: None,
        }
    );
    assert_eq!(pr.id().0, "bitbucket:acme/widgets#72");
}

#[tokio::test]
async fn create_pr_maps_an_already_open_pr_to_conflict() {
    let s = support::servers().await;

    Mock::given(method("POST"))
        .and(path("/repositories/acme/widgets/pullrequests"))
        .respond_with(ResponseTemplate::new(400).set_body_json(serde_json::json!({
            "type": "error",
            "error": {
                "message": "There is already an open pull request from feat/login to main."
            }
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

#[tokio::test]
async fn create_pr_keeps_other_400s_as_validation() {
    let s = support::servers().await;

    Mock::given(method("POST"))
        .and(path("/repositories/acme/widgets/pullrequests"))
        .respond_with(ResponseTemplate::new(400).set_body_json(serde_json::json!({
            "type": "error",
            "error": { "message": "There are no changes to be pulled" }
        })))
        .mount(&s.api)
        .await;

    let err = s
        .adapter
        .create_pr(&repo(), &new_pr(false))
        .await
        .unwrap_err();
    assert!(matches!(err, HostError::Validation(_)), "got {err:?}");
}
