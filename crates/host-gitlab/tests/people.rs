mod support;

use theodore_domain::{HostKind, PrRef, RepoRef};
use theodore_ports::HostAdapter;
use wiremock::matchers::{body_json, method, path, query_param};
use wiremock::{Mock, ResponseTemplate};

fn pr() -> PrRef {
    PrRef {
        repo: RepoRef {
            host: HostKind::Gitlab,
            owner: "acme".into(),
            name: "widgets".into(),
        },
        number: 42,
        host_id: Some("7".into()),
    }
}

fn mr_json(reviewers: serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "iid": 42,
        "project_id": 7,
        "title": "Add feature X",
        "state": "opened",
        "web_url": "https://gitlab.com/acme/widgets/-/merge_requests/42",
        "source_branch": "feature-x",
        "target_branch": "main",
        "sha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "author": { "id": 1, "username": "alice" },
        "reviewers": reviewers,
        "updated_at": "2024-01-01T00:00:00.000Z"
    })
}

#[tokio::test]
async fn request_reviewers_resolves_usernames_and_merges_with_the_existing_set() {
    let s = support::servers().await;

    Mock::given(method("GET"))
        .and(path("/projects/7/merge_requests/42"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(mr_json(serde_json::json!([
                { "id": 10, "username": "existing" }
            ]))),
        )
        .mount(&s.api)
        .await;

    Mock::given(method("GET"))
        .and(path("/users"))
        .and(query_param("username", "bob"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
            { "id": 20, "username": "bob" }
        ])))
        .mount(&s.api)
        .await;

    Mock::given(method("PUT"))
        .and(path("/projects/7/merge_requests/42"))
        .and(body_json(serde_json::json!({ "reviewer_ids": [10, 20] })))
        .respond_with(ResponseTemplate::new(200).set_body_json(mr_json(serde_json::json!([]))))
        .mount(&s.api)
        .await;

    s.adapter
        .request_reviewers(&pr(), &["bob".to_string()], &["ignored-team".to_string()])
        .await
        .unwrap();
}

#[tokio::test]
async fn remove_reviewer_drops_the_matching_username() {
    let s = support::servers().await;

    Mock::given(method("GET"))
        .and(path("/projects/7/merge_requests/42"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(mr_json(serde_json::json!([
                { "id": 10, "username": "alice" },
                { "id": 20, "username": "bob" }
            ]))),
        )
        .mount(&s.api)
        .await;

    Mock::given(method("PUT"))
        .and(path("/projects/7/merge_requests/42"))
        .and(body_json(serde_json::json!({ "reviewer_ids": [20] })))
        .respond_with(ResponseTemplate::new(200).set_body_json(mr_json(serde_json::json!([]))))
        .mount(&s.api)
        .await;

    s.adapter.remove_reviewer(&pr(), "alice").await.unwrap();
}

#[tokio::test]
async fn mark_ready_strips_the_draft_prefix() {
    let s = support::servers().await;

    Mock::given(method("GET"))
        .and(path("/projects/7/merge_requests/42"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "iid": 42, "project_id": 7, "title": "Draft: Add feature X", "state": "opened",
            "web_url": "https://gitlab.com/acme/widgets/-/merge_requests/42",
            "source_branch": "feature-x", "target_branch": "main",
            "sha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "author": { "id": 1, "username": "alice" }, "updated_at": "2024-01-01T00:00:00.000Z"
        })))
        .mount(&s.api)
        .await;

    Mock::given(method("PUT"))
        .and(path("/projects/7/merge_requests/42"))
        .and(body_json(serde_json::json!({ "title": "Add feature X" })))
        .respond_with(ResponseTemplate::new(200).set_body_json(mr_json(serde_json::json!([]))))
        .mount(&s.api)
        .await;

    s.adapter.mark_ready(&pr()).await.unwrap();
}

#[tokio::test]
async fn convert_to_draft_prepends_the_prefix() {
    let s = support::servers().await;

    Mock::given(method("GET"))
        .and(path("/projects/7/merge_requests/42"))
        .respond_with(ResponseTemplate::new(200).set_body_json(mr_json(serde_json::json!([]))))
        .mount(&s.api)
        .await;

    Mock::given(method("PUT"))
        .and(path("/projects/7/merge_requests/42"))
        .and(body_json(
            serde_json::json!({ "title": "Draft: Add feature X" }),
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(mr_json(serde_json::json!([]))))
        .mount(&s.api)
        .await;

    s.adapter.convert_to_draft(&pr()).await.unwrap();
}

#[tokio::test]
async fn assignable_users_paginates_project_members() {
    let s = support::servers().await;

    Mock::given(method("GET"))
        .and(path("/projects/acme%2Fwidgets/members/all"))
        .and(query_param("page", "1"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("x-next-page", "2")
                .set_body_json(serde_json::json!([
                    { "id": 1, "username": "alice" }
                ])),
        )
        .mount(&s.api)
        .await;
    Mock::given(method("GET"))
        .and(path("/projects/acme%2Fwidgets/members/all"))
        .and(query_param("page", "2"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
            { "id": 2, "username": "bob" }
        ])))
        .mount(&s.api)
        .await;

    let people = s.adapter.assignable_users(&pr().repo).await.unwrap();
    assert_eq!(people.len(), 2);
    assert_eq!(people[0].login, "alice");
    assert_eq!(people[1].login, "bob");
}
