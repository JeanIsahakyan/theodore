//! REST v4 calls, grouped by resource. Pagination for list endpoints is left
//! to callers (via [`crate::pagination::paginate_all`]) since the page
//! parameter lives in the query string each caller already builds.

use theodore_host_http::HttpClient;
use theodore_ports::{Fetched, HostError, HostResult};

use crate::anchor::GitlabPosition;
use crate::model::{
    CreateDraftNote, GlApprovals, GlChanges, GlCommit, GlDiscussion, GlMergeRequest, GlNote,
    GlPipeline, GlProject, GlTodo, GlUser, NoteBody,
};

pub(crate) async fn viewer(http: &HttpClient) -> HostResult<GlUser> {
    Ok(http.get::<GlUser>("user").await?.value)
}

pub(crate) async fn projects_page(
    http: &HttpClient,
    page: u32,
) -> HostResult<(Vec<GlProject>, reqwest::header::HeaderMap)> {
    let path = format!("projects?membership=true&min_access_level=20&page={page}&per_page=50");
    let resp = http.get::<Vec<GlProject>>(&path).await?;
    Ok((resp.value, resp.headers))
}

pub(crate) async fn list_merge_requests_page(
    http: &HttpClient,
    query: &str,
    page: u32,
) -> HostResult<(Vec<GlMergeRequest>, reqwest::header::HeaderMap)> {
    let path = format!("merge_requests?{query}&page={page}&per_page=50");
    let resp = http.get::<Vec<GlMergeRequest>>(&path).await?;
    Ok((resp.value, resp.headers))
}

pub(crate) async fn todos_page(
    http: &HttpClient,
    page: u32,
) -> HostResult<(Vec<GlTodo>, reqwest::header::HeaderMap)> {
    let path =
        format!("todos?state=pending&action=mentioned&type=MergeRequest&page={page}&per_page=50");
    let resp = http.get::<Vec<GlTodo>>(&path).await?;
    Ok((resp.value, resp.headers))
}

pub(crate) async fn get_merge_request(
    http: &HttpClient,
    project: &str,
    iid: u64,
    etag: Option<&str>,
) -> HostResult<Fetched<GlMergeRequest>> {
    let path = format!("projects/{project}/merge_requests/{iid}");
    match http.get_conditional::<GlMergeRequest>(&path, etag).await? {
        Fetched::NotModified => Ok(Fetched::NotModified),
        Fetched::Modified { etag, value } => Ok(Fetched::Modified {
            etag,
            value: value.value,
        }),
    }
}

pub(crate) async fn changes(http: &HttpClient, project: &str, iid: u64) -> HostResult<GlChanges> {
    let path = format!("projects/{project}/merge_requests/{iid}/changes");
    Ok(http.get::<GlChanges>(&path).await?.value)
}

pub(crate) async fn discussions_page(
    http: &HttpClient,
    project: &str,
    iid: u64,
    page: u32,
) -> HostResult<(Vec<GlDiscussion>, reqwest::header::HeaderMap)> {
    let path =
        format!("projects/{project}/merge_requests/{iid}/discussions?page={page}&per_page=50");
    let resp = http.get::<Vec<GlDiscussion>>(&path).await?;
    Ok((resp.value, resp.headers))
}

pub(crate) async fn pipelines(
    http: &HttpClient,
    project: &str,
    iid: u64,
) -> HostResult<Vec<GlPipeline>> {
    let path = format!("projects/{project}/merge_requests/{iid}/pipelines");
    Ok(http.get::<Vec<GlPipeline>>(&path).await?.value)
}

pub(crate) async fn approvals(
    http: &HttpClient,
    project: &str,
    iid: u64,
) -> HostResult<GlApprovals> {
    let path = format!("projects/{project}/merge_requests/{iid}/approvals");
    match http.get::<GlApprovals>(&path).await {
        // CE without approval rules, or the feature disabled: no useful
        // approvals data rather than a hard failure.
        Err(HostError::NotFound(_)) => Ok(GlApprovals {
            approved_by: vec![],
            approvals_required: None,
        }),
        other => Ok(other?.value),
    }
}

pub(crate) async fn commits_page(
    http: &HttpClient,
    project: &str,
    iid: u64,
    page: u32,
) -> HostResult<(Vec<GlCommit>, reqwest::header::HeaderMap)> {
    let path = format!("projects/{project}/merge_requests/{iid}/commits?page={page}&per_page=50");
    let resp = http.get::<Vec<GlCommit>>(&path).await?;
    Ok((resp.value, resp.headers))
}

pub(crate) async fn create_draft_note(
    http: &HttpClient,
    project: &str,
    iid: u64,
    note: &str,
    position: Option<&GitlabPosition>,
) -> HostResult<()> {
    let path = format!("projects/{project}/merge_requests/{iid}/draft_notes");
    let _: theodore_host_http::HttpResponse<serde_json::Value> = http
        .post_json(&path, &CreateDraftNote { note, position })
        .await?;
    Ok(())
}

pub(crate) async fn bulk_publish_draft_notes(
    http: &HttpClient,
    project: &str,
    iid: u64,
) -> HostResult<()> {
    let path = format!("projects/{project}/merge_requests/{iid}/draft_notes/bulk_publish");
    // GitLab answers this one with 204 and an empty body; `post_json` always
    // decodes the response as JSON (unlike `delete`, host-http has no
    // body-ignoring POST), so an empty-body decode failure here means the
    // call itself succeeded.
    match http
        .post_json::<_, serde_json::Value>(&path, &serde_json::json!({}))
        .await
    {
        Ok(_) => Ok(()),
        Err(HostError::Protocol(msg)) if msg.contains("EOF while parsing a value") => Ok(()),
        Err(e) => Err(e),
    }
}

pub(crate) async fn approve(http: &HttpClient, project: &str, iid: u64) -> HostResult<()> {
    let path = format!("projects/{project}/merge_requests/{iid}/approve");
    let _: theodore_host_http::HttpResponse<serde_json::Value> =
        http.post_json(&path, &serde_json::json!({})).await?;
    Ok(())
}

pub(crate) async fn reply_to_discussion(
    http: &HttpClient,
    project: &str,
    iid: u64,
    discussion_id: &str,
    body: &str,
) -> HostResult<GlNote> {
    let path = format!("projects/{project}/merge_requests/{iid}/discussions/{discussion_id}/notes");
    Ok(http.post_json(&path, &NoteBody { body }).await?.value)
}

pub(crate) async fn resolve_discussion(
    http: &HttpClient,
    project: &str,
    iid: u64,
    discussion_id: &str,
    resolved: bool,
) -> HostResult<()> {
    let path = format!(
        "projects/{project}/merge_requests/{iid}/discussions/{discussion_id}?resolved={resolved}"
    );
    let _: theodore_host_http::HttpResponse<serde_json::Value> =
        http.put_json(&path, &serde_json::json!({})).await?;
    Ok(())
}

pub(crate) async fn edit_note(
    http: &HttpClient,
    project: &str,
    iid: u64,
    note_id: &str,
    body: &str,
) -> HostResult<()> {
    let path = format!("projects/{project}/merge_requests/{iid}/notes/{note_id}");
    let _: theodore_host_http::HttpResponse<serde_json::Value> =
        http.put_json(&path, &NoteBody { body }).await?;
    Ok(())
}

pub(crate) async fn delete_note(
    http: &HttpClient,
    project: &str,
    iid: u64,
    note_id: &str,
) -> HostResult<()> {
    let path = format!("projects/{project}/merge_requests/{iid}/notes/{note_id}");
    http.delete(&path).await
}
