//! REST calls: notification polling and the two writes that don't have a
//! GraphQL equivalent worth using (comment edit/delete).

use serde::Deserialize;
use theodore_host_http::HttpClient;
use theodore_ports::HostResult;

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct GhNotification {
    pub subject: GhSubject,
    pub repository: GhRepository,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct GhSubject {
    #[serde(rename = "type")]
    pub kind: String,
    pub url: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct GhRepository {
    pub name: String,
    pub owner: GhOwner,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct GhOwner {
    pub login: String,
}

impl GhNotification {
    /// The PR number, parsed from the subject's API URL
    /// (`.../repos/o/r/pulls/42`). `None` for non-PR notifications.
    pub(crate) fn pr_number(&self) -> Option<u64> {
        if self.subject.kind != "PullRequest" {
            return None;
        }
        self.subject
            .url
            .as_deref()?
            .rsplit('/')
            .next()?
            .parse()
            .ok()
    }
}

pub(crate) struct NotificationsPoll {
    pub notifications: Vec<GhNotification>,
    /// Opaque cursor for the next call's `If-Modified-Since` (the response's
    /// `Last-Modified`, or the request's own cursor when nothing changed).
    pub cursor: String,
    pub poll_after_ms: Option<i64>,
}

pub(crate) async fn poll_notifications(
    http: &HttpClient,
    since: Option<&str>,
) -> HostResult<NotificationsPoll> {
    let headers: Vec<(&str, String)> = since
        .map(|s| vec![("if-modified-since", s.to_string())])
        .unwrap_or_default();
    let raw = http.get_raw("notifications", &headers).await?;
    let poll_after_ms = header(&raw.headers, "x-poll-interval")
        .and_then(|v| v.parse::<i64>().ok())
        .map(|s| s * 1000);

    if raw.not_modified {
        return Ok(NotificationsPoll {
            notifications: vec![],
            cursor: since.unwrap_or_default().to_string(),
            poll_after_ms,
        });
    }

    let notifications: Vec<GhNotification> = serde_json::from_str(&raw.body)
        .map_err(|e| theodore_ports::HostError::Protocol(format!("notifications decode: {e}")))?;
    let cursor = header(&raw.headers, "last-modified")
        .map(str::to_string)
        .unwrap_or_else(|| since.unwrap_or_default().to_string());
    Ok(NotificationsPoll {
        notifications,
        cursor,
        poll_after_ms,
    })
}

fn header<'a>(headers: &'a reqwest::header::HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name)?.to_str().ok()
}

pub(crate) async fn edit_comment(
    http: &HttpClient,
    owner: &str,
    repo: &str,
    comment_id: &str,
    body: &str,
) -> HostResult<()> {
    #[derive(serde::Serialize)]
    struct Body<'a> {
        body: &'a str,
    }
    let path = format!("repos/{owner}/{repo}/pulls/comments/{comment_id}");
    let _: theodore_host_http::HttpResponse<serde_json::Value> =
        http.patch_json(&path, &Body { body }).await?;
    Ok(())
}

pub(crate) async fn delete_comment(
    http: &HttpClient,
    owner: &str,
    repo: &str,
    comment_id: &str,
) -> HostResult<()> {
    let path = format!("repos/{owner}/{repo}/pulls/comments/{comment_id}");
    http.delete(&path).await
}

#[derive(serde::Serialize)]
struct RequestedReviewersBody<'a> {
    #[serde(skip_serializing_if = "<[_]>::is_empty")]
    reviewers: &'a [String],
    #[serde(skip_serializing_if = "<[_]>::is_empty")]
    team_reviewers: &'a [String],
}

/// `POST .../requested_reviewers`: takes logins/team slugs directly, no node
/// id lookup needed (unlike GraphQL's `requestReviews`).
pub(crate) async fn request_reviewers(
    http: &HttpClient,
    owner: &str,
    repo: &str,
    number: u64,
    users: &[String],
    teams: &[String],
) -> HostResult<()> {
    let path = format!("repos/{owner}/{repo}/pulls/{number}/requested_reviewers");
    let _: theodore_host_http::HttpResponse<serde_json::Value> = http
        .post_json(
            &path,
            &RequestedReviewersBody {
                reviewers: users,
                team_reviewers: teams,
            },
        )
        .await?;
    Ok(())
}

/// `DELETE .../requested_reviewers` (same resource, a body is required even
/// though this is a DELETE).
pub(crate) async fn remove_requested_reviewer(
    http: &HttpClient,
    owner: &str,
    repo: &str,
    number: u64,
    user: &str,
) -> HostResult<()> {
    let path = format!("repos/{owner}/{repo}/pulls/{number}/requested_reviewers");
    let users = [user.to_string()];
    http.delete_with_body(
        &path,
        &RequestedReviewersBody {
            reviewers: &users,
            team_reviewers: &[],
        },
    )
    .await
}

#[derive(serde::Serialize)]
struct ReactionBody<'a> {
    content: &'a str,
}

#[derive(Debug, Deserialize)]
pub(crate) struct GhReaction {
    pub id: u64,
    pub content: String,
    pub user: Option<GhReactionUser>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct GhReactionUser {
    pub login: String,
}

pub(crate) async fn add_reaction(
    http: &HttpClient,
    owner: &str,
    repo: &str,
    comment_id: &str,
    content: &str,
) -> HostResult<()> {
    let path = format!("repos/{owner}/{repo}/pulls/comments/{comment_id}/reactions");
    let _: theodore_host_http::HttpResponse<serde_json::Value> =
        http.post_json(&path, &ReactionBody { content }).await?;
    Ok(())
}

pub(crate) async fn list_reactions(
    http: &HttpClient,
    owner: &str,
    repo: &str,
    comment_id: &str,
) -> HostResult<Vec<GhReaction>> {
    let path = format!("repos/{owner}/{repo}/pulls/comments/{comment_id}/reactions");
    Ok(http.get::<Vec<GhReaction>>(&path).await?.value)
}

pub(crate) async fn delete_reaction(
    http: &HttpClient,
    owner: &str,
    repo: &str,
    comment_id: &str,
    reaction_id: u64,
) -> HostResult<()> {
    let path = format!("repos/{owner}/{repo}/pulls/comments/{comment_id}/reactions/{reaction_id}");
    http.delete(&path).await
}

/// `POST .../check-runs/{id}/rerequest`: re-queues one check run. Works for
/// any check-run app, including a single Actions job — but for a *failed*
/// Actions job, `rerun_failed_jobs` is preferred (it reruns the whole job,
/// not just the one check-run GitHub happens to have split it into).
pub(crate) async fn rerequest_check_run(
    http: &HttpClient,
    owner: &str,
    repo: &str,
    check_run_id: &str,
) -> HostResult<()> {
    let path = format!("repos/{owner}/{repo}/check-runs/{check_run_id}/rerequest");
    let _: theodore_host_http::HttpResponse<serde_json::Value> =
        http.post_json(&path, &serde_json::json!({})).await?;
    Ok(())
}

/// `POST .../actions/runs/{run_id}/rerun-failed-jobs`: reruns every failed
/// job of an Actions workflow run.
pub(crate) async fn rerun_workflow_failed_jobs(
    http: &HttpClient,
    owner: &str,
    repo: &str,
    run_id: &str,
) -> HostResult<()> {
    let path = format!("repos/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs");
    let _: theodore_host_http::HttpResponse<serde_json::Value> =
        http.post_json(&path, &serde_json::json!({})).await?;
    Ok(())
}
