mod support;

use theodore_domain::{HostKind, InboxReason, RepoRef};
use theodore_ports::{HostAdapter, InboxSection};
use wiremock::matchers::{method, path, query_param};
use wiremock::{Mock, ResponseTemplate};

async fn mount_user_endpoint(s: &support::Servers) {
    Mock::given(method("GET"))
        .and(path("/user"))
        .respond_with(ResponseTemplate::new(200).set_body_json(support::fixture("user.json")))
        .mount(&s.api)
        .await;
}

#[tokio::test]
async fn search_review_requested_filters_to_prs_where_viewer_is_a_reviewer() {
    let s = support::servers().await;
    mount_user_endpoint(&s).await;
    Mock::given(method("GET"))
        .and(path("/pullrequests/jsmith"))
        .and(query_param("q", "state=\"OPEN\""))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(support::fixture("pullrequests_for_user_page1.json")),
        )
        .mount(&s.api)
        .await;

    let prs = s
        .adapter
        .search(&InboxSection::ReviewRequested)
        .await
        .unwrap();
    // Only PR 42 lists the viewer (jsmith) as a REVIEWER participant; PR 7
    // is the viewer's own, authored PR.
    assert_eq!(prs.len(), 1);
    assert_eq!(prs[0].pr.number, 42);
    assert_eq!(prs[0].reasons, vec![InboxReason::ReviewRequested]);
}

#[tokio::test]
async fn search_authored_filters_to_prs_the_viewer_wrote() {
    let s = support::servers().await;
    mount_user_endpoint(&s).await;
    Mock::given(method("GET"))
        .and(path("/pullrequests/jsmith"))
        .and(query_param("q", "state=\"OPEN\""))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(support::fixture("pullrequests_for_user_page1.json")),
        )
        .mount(&s.api)
        .await;

    let prs = s.adapter.search(&InboxSection::Authored).await.unwrap();
    assert_eq!(prs.len(), 1);
    assert_eq!(prs[0].pr.number, 7);
    assert_eq!(prs[0].reasons, vec![InboxReason::Authored]);
}

#[tokio::test]
async fn search_assigned_and_mentioned_are_empty_without_a_network_call() {
    // Bitbucket pull requests have no assignee and no cheap "mentioned"
    // index; neither section should even need the viewer lookup.
    let s = support::servers().await;
    assert_eq!(
        s.adapter.search(&InboxSection::Assigned).await.unwrap(),
        vec![]
    );
    assert_eq!(
        s.adapter.search(&InboxSection::Mentioned).await.unwrap(),
        vec![]
    );
}

#[tokio::test]
async fn search_query_passes_the_raw_bbql_through() {
    let s = support::servers().await;
    mount_user_endpoint(&s).await;
    Mock::given(method("GET"))
        .and(path("/pullrequests/jsmith"))
        .and(query_param(
            "q",
            "state=\"OPEN\" AND (reviewers.uuid=\"{x}\")",
        ))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(support::fixture("pullrequests_for_user_page1.json")),
        )
        .mount(&s.api)
        .await;

    let prs = s
        .adapter
        .search(&InboxSection::Query("reviewers.uuid=\"{x}\"".into()))
        .await
        .unwrap();
    assert_eq!(prs.len(), 2);
}

fn repo() -> RepoRef {
    RepoRef {
        host: HostKind::Bitbucket,
        owner: "acme".into(),
        name: "widgets".into(),
    }
}

#[tokio::test]
async fn search_repo_review_requested_uses_the_repo_scoped_endpoint() {
    let s = support::servers().await;
    mount_user_endpoint(&s).await;
    Mock::given(method("GET"))
        .and(path("/repositories/acme/widgets/pullrequests"))
        .and(query_param("q", "state=\"OPEN\""))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(support::fixture("pullrequests_for_user_page1.json")),
        )
        .mount(&s.api)
        .await;

    let prs = s
        .adapter
        .search_repo(&repo(), &InboxSection::ReviewRequested)
        .await
        .unwrap();
    assert_eq!(prs.len(), 1);
    assert_eq!(prs[0].pr.number, 42);
}

#[tokio::test]
async fn search_repo_assigned_is_empty_without_a_network_call() {
    let s = support::servers().await;
    assert_eq!(
        s.adapter
            .search_repo(&repo(), &InboxSection::Assigned)
            .await
            .unwrap(),
        vec![]
    );
}
