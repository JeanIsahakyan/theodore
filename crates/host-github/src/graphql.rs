//! Hand-written GraphQL query strings + serde DTOs.
//!
//! `cynic` is wired up (schema registered in `build.rs`, exercised by the
//! `cynic_probe_tests` module below) but the PR/review queries here use plain
//! query strings. GitHub's public schema is >75k lines with deep unions
//! (`RequestedReviewer`, `StatusCheckRollupContext`) and nested connections;
//! getting `cynic`'s `QueryFragment` derives exactly right against it — and
//! re-deriving them as the schema evolves — cost more than it saved for a
//! single-slice build. Hand-written strings + targeted serde structs are
//! easier to keep correct and to test against fixtures. See the final report
//! for the full tradeoff.

use serde::{Deserialize, Serialize};
use serde_json::json;
use theodore_host_http::HttpClient;
use theodore_ports::{HostError, HostResult};

use crate::pagination::Connection;

// ── transport ────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct GqlError {
    message: String,
    #[serde(rename = "type")]
    kind: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GqlResponse<T> {
    data: Option<T>,
    #[serde(default)]
    errors: Option<Vec<GqlError>>,
}

/// Executes one GraphQL request. Transport-level failures (401, 403, 429,
/// 5xx, network) are already mapped to `HostError` by `HttpClient`; this
/// only classifies body-level `errors`.
pub(crate) async fn graphql<T: for<'de> Deserialize<'de>>(
    http: &HttpClient,
    query: &str,
    variables: serde_json::Value,
) -> HostResult<T> {
    let body = json!({ "query": query, "variables": variables });
    let resp: theodore_host_http::HttpResponse<GqlResponse<T>> = http.post_json("", &body).await?;
    let GqlResponse { data, errors } = resp.value;

    if let Some(errors) = &errors {
        if data.is_none() {
            return Err(classify_graphql_errors(errors));
        }
        tracing::warn!(?errors, "graphql returned partial errors alongside data");
    }

    data.ok_or_else(|| HostError::Protocol("graphql response had neither data nor errors".into()))
}

fn classify_graphql_errors(errors: &[GqlError]) -> HostError {
    let message = errors
        .iter()
        .map(|e| e.message.as_str())
        .collect::<Vec<_>>()
        .join("; ");
    let kind = errors
        .first()
        .and_then(|e| e.kind.as_deref())
        .unwrap_or_default();
    match kind {
        "NOT_FOUND" => HostError::NotFound(message),
        "FORBIDDEN" | "INSUFFICIENT_SCOPES" => HostError::Auth,
        "RATE_LIMITED" => HostError::RateLimited { reset_at: 0 },
        _ => HostError::Validation(message),
    }
}

// A minimal real `cynic` query, proving the registered schema compiles and
// can drive a typed request. Gated to tests: nothing on the hot paths below
// uses `cynic` (see module docs), so these items would otherwise be dead
// code in a normal build.
#[cfg(test)]
#[cynic::schema("github")]
mod schema {}

// `QueryFragment` defines query *shape*, not a type whose fields get read at
// runtime — cynic only ever constructs the query string from it.
#[cfg(test)]
#[derive(cynic::QueryFragment, Debug)]
#[cynic(schema = "github", graphql_type = "Query")]
#[allow(dead_code)]
struct ViewerLoginQuery {
    viewer: Actor,
}

#[cfg(test)]
#[derive(cynic::QueryFragment, Debug)]
#[cynic(schema = "github", graphql_type = "User")]
#[allow(dead_code)]
struct Actor {
    login: String,
}

#[cfg(test)]
fn viewer_login_operation() -> cynic::Operation<ViewerLoginQuery, ()> {
    use cynic::QueryBuilder;
    ViewerLoginQuery::build(())
}

#[cfg(test)]
mod cynic_probe_tests {
    use super::*;

    /// Proves the registered schema + a real `cynic::QueryFragment` compile
    /// and produce a well-formed operation (the PR/review queries below are
    /// hand-written strings instead; see the module docs for why).
    #[test]
    fn viewer_login_query_compiles_and_renders() {
        let op = viewer_login_operation();
        assert!(op.query.contains("viewer"));
        assert!(op.query.contains("login"));
    }
}

// ── shared fragments ────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct GqlActor {
    login: String,
    #[serde(rename = "avatarUrl")]
    avatar_url: Option<String>,
    name: Option<String>,
}

impl GqlActor {
    pub(crate) fn into_person(self) -> theodore_domain::Person {
        theodore_domain::Person {
            login: self.login,
            name: self.name,
            avatar_url: self.avatar_url,
        }
    }
}

// ── PR node id ──────────────────────────────────────────────────────────

const PR_NODE_ID_QUERY: &str = r#"
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) { id }
  }
}
"#;

#[derive(Debug, Deserialize)]
struct PrNodeIdData {
    repository: Option<RepoWrap<PrId>>,
}
#[derive(Debug, Deserialize)]
struct RepoWrap<T> {
    #[serde(rename = "pullRequest")]
    pull_request: Option<T>,
}
#[derive(Debug, Deserialize)]
struct PrId {
    id: String,
}

pub(crate) async fn resolve_pr_node_id(
    http: &HttpClient,
    owner: &str,
    repo: &str,
    number: u64,
) -> HostResult<String> {
    let data: PrNodeIdData = graphql(
        http,
        PR_NODE_ID_QUERY,
        json!({ "owner": owner, "repo": repo, "number": number }),
    )
    .await?;
    data.repository
        .and_then(|r| r.pull_request)
        .map(|p| p.id)
        .ok_or_else(|| HostError::NotFound(format!("{owner}/{repo}#{number}")))
}

// ── PR core fields (everything except files/threads, which paginate) ──────

const PR_CORE_QUERY: &str = r#"
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      id
      title
      body
      url
      state
      isDraft
      additions
      deletions
      changedFiles
      baseRefName
      headRefName
      baseRefOid
      headRefOid
      updatedAt
      author { login avatarUrl ... on User { name } }
      labels(first: 100) { nodes { name } }
      assignees(first: 100) { nodes { login name avatarUrl } }
      reviewRequests(first: 100) {
        nodes {
          requestedReviewer {
            __typename
            ... on User { login name avatarUrl }
            ... on Team { name }
          }
        }
      }
      latestReviews(first: 100) {
        nodes {
          state
          author { login avatarUrl ... on User { name } }
        }
      }
      commits(last: 100) {
        nodes {
          commit {
            oid
            message
            committedDate
            author { name user { login avatarUrl } }
          }
        }
      }
      statusCheckRollup {
        state
        contexts(first: 100) {
          nodes {
            __typename
            ... on CheckRun { id name status conclusion detailsUrl startedAt completedAt }
            ... on StatusContext { id context state targetUrl }
          }
        }
      }
    }
  }
}
"#;

#[derive(Debug, Deserialize)]
pub(crate) struct GqlPrCore {
    pub id: String,
    pub title: String,
    pub body: String,
    pub url: String,
    pub state: String,
    #[serde(rename = "isDraft")]
    pub is_draft: bool,
    pub additions: u32,
    pub deletions: u32,
    #[serde(rename = "changedFiles")]
    pub changed_files: u32,
    #[serde(rename = "baseRefName")]
    pub base_ref_name: String,
    #[serde(rename = "headRefName")]
    pub head_ref_name: String,
    #[serde(rename = "baseRefOid")]
    pub base_ref_oid: String,
    #[serde(rename = "headRefOid")]
    pub head_ref_oid: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
    pub author: Option<GqlActor>,
    pub labels: Option<Connection<GqlLabel>>,
    pub assignees: Connection<GqlActor>,
    #[serde(rename = "reviewRequests")]
    pub review_requests: Option<Connection<GqlReviewRequest>>,
    #[serde(rename = "latestReviews")]
    pub latest_reviews: Option<Connection<GqlReview>>,
    pub commits: Connection<GqlPrCommitNode>,
    #[serde(rename = "statusCheckRollup")]
    pub status_check_rollup: Option<GqlStatusCheckRollup>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct GqlLabel {
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct GqlReviewRequest {
    #[serde(rename = "requestedReviewer")]
    pub requested_reviewer: Option<GqlRequestedReviewer>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct GqlRequestedReviewer {
    #[serde(rename = "__typename")]
    pub typename: String,
    pub login: Option<String>,
    pub name: Option<String>,
    #[serde(rename = "avatarUrl")]
    pub avatar_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct GqlReview {
    pub state: String,
    pub author: Option<GqlActor>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct GqlPrCommitNode {
    pub commit: GqlCommit,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct GqlCommit {
    pub oid: String,
    pub message: String,
    #[serde(rename = "committedDate")]
    pub committed_date: String,
    pub author: Option<GqlGitActor>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct GqlGitActor {
    pub name: Option<String>,
    pub user: Option<GqlActorLite>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct GqlActorLite {
    pub login: String,
    #[serde(rename = "avatarUrl")]
    pub avatar_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct GqlStatusCheckRollup {
    pub state: String,
    pub contexts: Connection<GqlCheckContext>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct GqlCheckContext {
    #[serde(rename = "__typename")]
    pub typename: String,
    pub id: String,
    pub name: Option<String>,
    pub status: Option<String>,
    pub conclusion: Option<String>,
    #[serde(rename = "detailsUrl")]
    pub details_url: Option<String>,
    #[serde(rename = "startedAt")]
    pub started_at: Option<String>,
    #[serde(rename = "completedAt")]
    pub completed_at: Option<String>,
    pub context: Option<String>,
    /// `StatusContext.state` (`StatusState`); `CheckRun` has `status`/`conclusion` instead.
    pub state: Option<String>,
    #[serde(rename = "targetUrl")]
    pub target_url: Option<String>,
}

pub(crate) async fn fetch_pr_core(
    http: &HttpClient,
    owner: &str,
    repo: &str,
    number: u64,
) -> HostResult<GqlPrCore> {
    #[derive(Debug, Deserialize)]
    struct Data {
        repository: Option<RepoWrap<GqlPrCore>>,
    }
    let data: Data = graphql(
        http,
        PR_CORE_QUERY,
        json!({ "owner": owner, "repo": repo, "number": number }),
    )
    .await?;
    data.repository
        .and_then(|r| r.pull_request)
        .ok_or_else(|| HostError::NotFound(format!("{owner}/{repo}#{number}")))
}

// ── files (paginated) ───────────────────────────────────────────────────

const PR_FILES_PAGE_QUERY: &str = r#"
query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      files(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { path viewerViewedState }
      }
    }
  }
}
"#;

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct GqlFile {
    pub path: String,
    #[serde(rename = "viewerViewedState")]
    pub viewer_viewed_state: String,
}

pub(crate) async fn fetch_files_page(
    http: &HttpClient,
    owner: &str,
    repo: &str,
    number: u64,
    after: Option<String>,
) -> HostResult<Connection<GqlFile>> {
    #[derive(Debug, Deserialize)]
    struct FilesWrap {
        files: Connection<GqlFile>,
    }
    #[derive(Debug, Deserialize)]
    struct Data {
        repository: Option<RepoWrap<FilesWrap>>,
    }
    let data: Data = graphql(
        http,
        PR_FILES_PAGE_QUERY,
        json!({ "owner": owner, "repo": repo, "number": number, "after": after }),
    )
    .await?;
    Ok(data
        .repository
        .and_then(|r| r.pull_request)
        .map(|p| p.files)
        .unwrap_or(Connection {
            nodes: vec![],
            page_info: crate::pagination::PageInfo {
                has_next_page: false,
                end_cursor: None,
            },
        }))
}

// ── review threads + comments (paginated) ──────────────────────────────

const PR_THREADS_PAGE_QUERY: &str = r#"
query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 50, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          startLine
          diffSide
          startDiffSide
          comments(first: 50) {
            nodes {
              fullDatabaseId
              body
              createdAt
              lastEditedAt
              author { login avatarUrl ... on User { name } }
            }
          }
        }
      }
    }
  }
}
"#;

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct GqlThread {
    pub id: String,
    #[serde(rename = "isResolved")]
    pub is_resolved: bool,
    #[serde(rename = "isOutdated")]
    pub is_outdated: bool,
    pub path: String,
    pub line: Option<u32>,
    #[serde(rename = "startLine")]
    pub start_line: Option<u32>,
    #[serde(rename = "diffSide")]
    pub diff_side: String,
    #[serde(rename = "startDiffSide")]
    pub start_diff_side: Option<String>,
    pub comments: Connection<GqlThreadComment>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct GqlThreadComment {
    #[serde(
        rename = "fullDatabaseId",
        deserialize_with = "deserialize_flexible_id"
    )]
    pub full_database_id: String,
    pub body: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "lastEditedAt")]
    pub last_edited_at: Option<String>,
    pub author: Option<GqlActor>,
}

/// `fullDatabaseId` is GitHub's `BigInt` scalar; some responses send it as a
/// JSON number, others as a string. Accept either.
fn deserialize_flexible_id<'de, D>(d: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let v = serde_json::Value::deserialize(d)?;
    match v {
        serde_json::Value::String(s) => Ok(s),
        serde_json::Value::Number(n) => Ok(n.to_string()),
        other => Err(serde::de::Error::custom(format!(
            "expected string or number, got {other}"
        ))),
    }
}

pub(crate) async fn fetch_threads_page(
    http: &HttpClient,
    owner: &str,
    repo: &str,
    number: u64,
    after: Option<String>,
) -> HostResult<Connection<GqlThread>> {
    #[derive(Debug, Deserialize)]
    struct ThreadsWrap {
        #[serde(rename = "reviewThreads")]
        review_threads: Connection<GqlThread>,
    }
    #[derive(Debug, Deserialize)]
    struct Data {
        repository: Option<RepoWrap<ThreadsWrap>>,
    }
    let data: Data = graphql(
        http,
        PR_THREADS_PAGE_QUERY,
        json!({ "owner": owner, "repo": repo, "number": number, "after": after }),
    )
    .await?;
    Ok(data
        .repository
        .and_then(|r| r.pull_request)
        .map(|p| p.review_threads)
        .unwrap_or(Connection {
            nodes: vec![],
            page_info: crate::pagination::PageInfo {
                has_next_page: false,
                end_cursor: None,
            },
        }))
}

// ── mutations ───────────────────────────────────────────────────────────

const MARK_FILE_AS_VIEWED: &str = r#"
mutation($pullRequestId: ID!, $path: String!) {
  markFileAsViewed(input: { pullRequestId: $pullRequestId, path: $path }) { clientMutationId }
}
"#;

const UNMARK_FILE_AS_VIEWED: &str = r#"
mutation($pullRequestId: ID!, $path: String!) {
  unmarkFileAsViewed(input: { pullRequestId: $pullRequestId, path: $path }) { clientMutationId }
}
"#;

pub(crate) async fn set_viewed(
    http: &HttpClient,
    pull_request_id: &str,
    path: &str,
    viewed: bool,
) -> HostResult<()> {
    #[derive(Debug, Deserialize)]
    struct Ack {
        #[serde(rename = "clientMutationId")]
        _client_mutation_id: Option<String>,
    }
    #[derive(Debug, Deserialize)]
    struct Data {
        #[serde(alias = "markFileAsViewed", alias = "unmarkFileAsViewed")]
        _ack: Option<Ack>,
    }
    let query = if viewed {
        MARK_FILE_AS_VIEWED
    } else {
        UNMARK_FILE_AS_VIEWED
    };
    let _: Data = graphql(
        http,
        query,
        json!({ "pullRequestId": pull_request_id, "path": path }),
    )
    .await?;
    Ok(())
}

#[derive(Debug, Serialize)]
pub(crate) struct DraftThread {
    pub path: String,
    pub line: u32,
    pub side: &'static str,
    #[serde(rename = "startLine", skip_serializing_if = "Option::is_none")]
    pub start_line: Option<u32>,
    #[serde(rename = "startSide", skip_serializing_if = "Option::is_none")]
    pub start_side: Option<&'static str>,
    pub body: String,
}

const ADD_PULL_REQUEST_REVIEW: &str = r#"
mutation($pullRequestId: ID!, $event: PullRequestReviewEvent!, $body: String!, $commitOID: GitObjectID!, $threads: [DraftPullRequestReviewThread!]) {
  addPullRequestReview(input: { pullRequestId: $pullRequestId, event: $event, body: $body, commitOID: $commitOID, threads: $threads }) {
    pullRequestReview { id }
  }
}
"#;

#[derive(Debug, Deserialize)]
struct AddReviewData {
    #[serde(rename = "addPullRequestReview")]
    add_pull_request_review: Option<AddReviewPayload>,
}
#[derive(Debug, Deserialize)]
struct AddReviewPayload {
    #[serde(rename = "pullRequestReview")]
    pull_request_review: Option<ReviewRef>,
}
#[derive(Debug, Deserialize)]
struct ReviewRef {
    id: String,
}

pub(crate) async fn add_pull_request_review(
    http: &HttpClient,
    pull_request_id: &str,
    event: &str,
    body: &str,
    commit_oid: &str,
    threads: Vec<DraftThread>,
) -> HostResult<String> {
    let data: AddReviewData = graphql(
        http,
        ADD_PULL_REQUEST_REVIEW,
        json!({
            "pullRequestId": pull_request_id,
            "event": event,
            "body": body,
            "commitOID": commit_oid,
            "threads": threads,
        }),
    )
    .await?;
    data.add_pull_request_review
        .and_then(|p| p.pull_request_review)
        .map(|r| r.id)
        .ok_or_else(|| HostError::Protocol("addPullRequestReview returned no review".into()))
}

const RESOLVE_REVIEW_THREAD: &str = r#"
mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) { thread { id } }
}
"#;

const UNRESOLVE_REVIEW_THREAD: &str = r#"
mutation($threadId: ID!) {
  unresolveReviewThread(input: { threadId: $threadId }) { thread { id } }
}
"#;

pub(crate) async fn resolve_thread(
    http: &HttpClient,
    thread_id: &str,
    resolved: bool,
) -> HostResult<()> {
    #[derive(Debug, Deserialize)]
    struct ThreadRef {
        #[allow(dead_code)]
        id: String,
    }
    #[derive(Debug, Deserialize)]
    struct Payload {
        thread: Option<ThreadRef>,
    }
    #[derive(Debug, Deserialize)]
    struct Data {
        #[serde(alias = "resolveReviewThread", alias = "unresolveReviewThread")]
        payload: Option<Payload>,
    }
    let query = if resolved {
        RESOLVE_REVIEW_THREAD
    } else {
        UNRESOLVE_REVIEW_THREAD
    };
    let data: Data = graphql(http, query, json!({ "threadId": thread_id })).await?;
    data.payload
        .and_then(|p| p.thread)
        .map(|_| ())
        .ok_or_else(|| HostError::NotFound(format!("thread {thread_id}")))
}

const ADD_REVIEW_THREAD_REPLY: &str = r#"
mutation($pullRequestReviewThreadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $pullRequestReviewThreadId, body: $body }) {
    comment { id fullDatabaseId }
  }
}
"#;

#[derive(Debug, Deserialize)]
struct ReplyData {
    #[serde(rename = "addPullRequestReviewThreadReply")]
    add_pull_request_review_thread_reply: Option<ReplyPayload>,
}
#[derive(Debug, Deserialize)]
struct ReplyPayload {
    comment: Option<ReplyComment>,
}
#[derive(Debug, Deserialize)]
struct ReplyComment {
    #[serde(deserialize_with = "deserialize_flexible_id")]
    #[serde(rename = "fullDatabaseId")]
    full_database_id: String,
}

pub(crate) async fn add_review_thread_reply(
    http: &HttpClient,
    thread_id: &str,
    body: &str,
) -> HostResult<String> {
    let data: ReplyData = graphql(
        http,
        ADD_REVIEW_THREAD_REPLY,
        json!({ "pullRequestReviewThreadId": thread_id, "body": body }),
    )
    .await?;
    data.add_pull_request_review_thread_reply
        .and_then(|p| p.comment)
        .map(|c| c.full_database_id)
        .ok_or_else(|| {
            HostError::Protocol("addPullRequestReviewThreadReply returned no comment".into())
        })
}

// ── search ──────────────────────────────────────────────────────────────

const SEARCH_PRS_QUERY: &str = r#"
query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: 50, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      __typename
      ... on PullRequest {
        number
        title
        url
        state
        isDraft
        additions
        deletions
        changedFiles
        baseRefName
        headRefName
        headRefOid
        updatedAt
        repository { name owner { login } }
        author { login avatarUrl ... on User { name } }
        latestReviews(first: 20) { nodes { state } }
        statusCheckRollup { state }
      }
    }
  }
}
"#;

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct GqlSearchPr {
    #[serde(rename = "__typename")]
    pub typename: String,
    pub number: Option<u64>,
    pub title: Option<String>,
    pub url: Option<String>,
    pub state: Option<String>,
    #[serde(rename = "isDraft")]
    pub is_draft: Option<bool>,
    pub additions: Option<u32>,
    pub deletions: Option<u32>,
    #[serde(rename = "changedFiles")]
    pub changed_files: Option<u32>,
    #[serde(rename = "baseRefName")]
    pub base_ref_name: Option<String>,
    #[serde(rename = "headRefName")]
    pub head_ref_name: Option<String>,
    #[serde(rename = "headRefOid")]
    pub head_ref_oid: Option<String>,
    #[serde(rename = "updatedAt")]
    pub updated_at: Option<String>,
    pub repository: Option<GqlSearchRepo>,
    pub author: Option<GqlActor>,
    #[serde(rename = "latestReviews")]
    pub latest_reviews: Option<Connection<GqlReview>>,
    #[serde(rename = "statusCheckRollup")]
    pub status_check_rollup: Option<GqlStatusCheckRollup>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct GqlSearchRepo {
    pub name: String,
    pub owner: GqlOwner,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct GqlOwner {
    pub login: String,
}

pub(crate) async fn search_prs(http: &HttpClient, query: &str) -> HostResult<Vec<GqlSearchPr>> {
    #[derive(Debug, Deserialize)]
    struct Data {
        search: Connection<GqlSearchPr>,
    }
    let nodes = crate::pagination::paginate_all(|after| async move {
        let data: Data = graphql(
            http,
            SEARCH_PRS_QUERY,
            json!({ "q": query, "after": after }),
        )
        .await?;
        Ok(data.search)
    })
    .await?;
    Ok(nodes
        .into_iter()
        .filter(|n| n.typename == "PullRequest")
        .collect())
}

// ── list_repos ──────────────────────────────────────────────────────────

const LIST_REPOS_QUERY: &str = r#"
query($after: String) {
  viewer {
    repositories(first: 100, after: $after, affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]) {
      pageInfo { hasNextPage endCursor }
      nodes { name owner { login } }
    }
  }
}
"#;

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct GqlRepo {
    pub name: String,
    pub owner: GqlOwner,
}

pub(crate) async fn list_repos(http: &HttpClient) -> HostResult<Vec<GqlRepo>> {
    #[derive(Debug, Deserialize)]
    struct ViewerWrap {
        viewer: Viewer,
    }
    #[derive(Debug, Deserialize)]
    struct Viewer {
        repositories: Connection<GqlRepo>,
    }

    crate::pagination::paginate_all(|after| async move {
        let data: ViewerWrap = graphql(http, LIST_REPOS_QUERY, json!({ "after": after })).await?;
        Ok(data.viewer.repositories)
    })
    .await
}
