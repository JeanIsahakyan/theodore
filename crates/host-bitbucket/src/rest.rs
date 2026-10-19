//! REST API 2.0 calls, grouped by resource. Pagination for list endpoints is
//! handled uniformly by [`crate::pagination::paginate_all`] (plan §6.9).

use theodore_ports::HostResult;

use crate::http::BbHttp;
use crate::model::{
    BbComment, BbCommit, BbDiffStatEntry, BbPullRequest, BbRepository, BbStatus, BbUser,
    CreateCommentBody, MergeBody,
};
use crate::pagination::paginate_all;

pub(crate) async fn viewer(http: &BbHttp) -> HostResult<BbUser> {
    http.get("user").await
}

/// `role=member`: every repo this account can at least read, across every
/// workspace it belongs to (plan "Add project" picker needs the lot, not one
/// workspace at a time).
pub(crate) async fn repositories(http: &BbHttp) -> HostResult<Vec<BbRepository>> {
    paginate_all(http, "repositories?role=member&pagelen=50").await
}

pub(crate) async fn pull_requests_for_user(
    http: &BbHttp,
    handle: &str,
    q: &str,
) -> HostResult<Vec<BbPullRequest>> {
    let path = format!("pullrequests/{}?{}&pagelen=50", urlencode(handle), q);
    paginate_all(http, &path).await
}

pub(crate) async fn repo_pull_requests(
    http: &BbHttp,
    workspace: &str,
    repo_slug: &str,
    q: &str,
) -> HostResult<Vec<BbPullRequest>> {
    let path = format!(
        "repositories/{}/{}/pullrequests?{q}&pagelen=50",
        urlencode(workspace),
        urlencode(repo_slug),
    );
    paginate_all(http, &path).await
}

pub(crate) async fn get_pull_request(
    http: &BbHttp,
    workspace: &str,
    repo_slug: &str,
    id: u64,
) -> HostResult<BbPullRequest> {
    http.get(&pr_path(workspace, repo_slug, id, "")).await
}

pub(crate) async fn diffstat(
    http: &BbHttp,
    workspace: &str,
    repo_slug: &str,
    id: u64,
) -> HostResult<Vec<BbDiffStatEntry>> {
    paginate_all(
        http,
        &pr_path(workspace, repo_slug, id, "/diffstat?pagelen=100"),
    )
    .await
}

pub(crate) async fn commits(
    http: &BbHttp,
    workspace: &str,
    repo_slug: &str,
    id: u64,
) -> HostResult<Vec<BbCommit>> {
    paginate_all(
        http,
        &pr_path(workspace, repo_slug, id, "/commits?pagelen=50"),
    )
    .await
}

pub(crate) async fn statuses(
    http: &BbHttp,
    workspace: &str,
    repo_slug: &str,
    id: u64,
) -> HostResult<Vec<BbStatus>> {
    paginate_all(
        http,
        &pr_path(workspace, repo_slug, id, "/statuses?pagelen=50"),
    )
    .await
}

pub(crate) async fn comments(
    http: &BbHttp,
    workspace: &str,
    repo_slug: &str,
    id: u64,
) -> HostResult<Vec<BbComment>> {
    paginate_all(
        http,
        &pr_path(workspace, repo_slug, id, "/comments?pagelen=100"),
    )
    .await
}

pub(crate) async fn create_comment(
    http: &BbHttp,
    workspace: &str,
    repo_slug: &str,
    id: u64,
    body: &CreateCommentBody<'_>,
) -> HostResult<BbComment> {
    http.post_json(&pr_path(workspace, repo_slug, id, "/comments"), body)
        .await
}

pub(crate) async fn edit_comment(
    http: &BbHttp,
    workspace: &str,
    repo_slug: &str,
    id: u64,
    comment_id: &str,
    content: &str,
) -> HostResult<BbComment> {
    let path = pr_path(workspace, repo_slug, id, &format!("/comments/{comment_id}"));
    http.put_json(
        &path,
        &CreateCommentBody {
            content: crate::model::BbContent {
                raw: content.to_string(),
            },
            inline: None,
            parent: None,
        },
    )
    .await
}

pub(crate) async fn delete_comment(
    http: &BbHttp,
    workspace: &str,
    repo_slug: &str,
    id: u64,
    comment_id: &str,
) -> HostResult<()> {
    let path = pr_path(workspace, repo_slug, id, &format!("/comments/{comment_id}"));
    http.delete(&path).await
}

pub(crate) async fn resolve_comment(
    http: &BbHttp,
    workspace: &str,
    repo_slug: &str,
    id: u64,
    comment_id: &str,
) -> HostResult<()> {
    let path = pr_path(
        workspace,
        repo_slug,
        id,
        &format!("/comments/{comment_id}/resolve"),
    );
    http.post_empty(&path).await
}

pub(crate) async fn reopen_comment(
    http: &BbHttp,
    workspace: &str,
    repo_slug: &str,
    id: u64,
    comment_id: &str,
) -> HostResult<()> {
    let path = pr_path(
        workspace,
        repo_slug,
        id,
        &format!("/comments/{comment_id}/resolve"),
    );
    http.delete(&path).await
}

pub(crate) async fn approve(
    http: &BbHttp,
    workspace: &str,
    repo_slug: &str,
    id: u64,
) -> HostResult<()> {
    http.post_empty(&pr_path(workspace, repo_slug, id, "/approve"))
        .await
}

pub(crate) async fn request_changes(
    http: &BbHttp,
    workspace: &str,
    repo_slug: &str,
    id: u64,
) -> HostResult<()> {
    http.post_empty(&pr_path(workspace, repo_slug, id, "/request-changes"))
        .await
}

pub(crate) async fn merge(
    http: &BbHttp,
    workspace: &str,
    repo_slug: &str,
    id: u64,
    body: &MergeBody<'_>,
) -> HostResult<BbPullRequest> {
    http.post_json(&pr_path(workspace, repo_slug, id, "/merge"), body)
        .await
}

fn pr_path(workspace: &str, repo_slug: &str, id: u64, suffix: &str) -> String {
    format!(
        "repositories/{}/{}/pullrequests/{id}{suffix}",
        urlencode(workspace),
        urlencode(repo_slug),
    )
}

fn urlencode(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}
