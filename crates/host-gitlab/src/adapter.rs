use std::sync::Arc;

use async_trait::async_trait;
use theodore_domain::{
    Check, CheckRollup, CheckStatus, Comment, CommentId, Commit, HostKind, InboxReason, Person,
    PrDetail, PrRef, PrState, PrSummary, RepoRef, ReviewEvent, Reviewer, ReviewerState, Sha,
    Thread, ThreadId,
};
use theodore_host_http::{HttpClient, TokenSource};
use theodore_ports::{
    Capabilities, Changes, Clock, Fetched, HostAdapter, HostError, HostResult, InboxSection,
    ReviewSubmission, SubmittedReview,
};

use crate::anchor::{self, DiffRefs};
use crate::model::{GlDiscussion, GlMergeRequest, GlNote, GlUser};
use crate::{pagination, rest, time};

/// `HostAdapter` for gitlab.com and self-managed GitLab.
pub struct GitlabAdapter {
    http: HttpClient,
    clock: Arc<dyn Clock>,
    viewer_username: tokio::sync::OnceCell<String>,
}

impl GitlabAdapter {
    pub fn new(token: Arc<dyn TokenSource>, clock: Arc<dyn Clock>) -> Self {
        Self::with_base_url(
            url::Url::parse("https://gitlab.com/api/v4/").expect("valid url"),
            token,
            clock,
        )
    }

    /// `base` must end with `/` (e.g. `https://gitlab.example.com/api/v4/`
    /// for self-managed, or a wiremock server's `uri() + "/"` in tests).
    pub fn with_base_url(
        base: url::Url,
        token: Arc<dyn TokenSource>,
        clock: Arc<dyn Clock>,
    ) -> Self {
        Self {
            http: HttpClient::new(base, token, clock.clone()),
            clock,
            viewer_username: tokio::sync::OnceCell::new(),
        }
    }

    async fn username(&self) -> HostResult<&str> {
        self.viewer_username
            .get_or_try_init(|| async { Ok(rest::viewer(&self.http).await?.username) })
            .await
            .map(String::as_str)
    }

    async fn fetch_diff_refs(&self, pr: &PrRef) -> HostResult<DiffRefs> {
        let project = project_id(pr);
        let mr = match rest::get_merge_request(&self.http, &project, pr.number, None).await? {
            Fetched::Modified { value, .. } => value,
            Fetched::NotModified => unreachable!("no etag sent"),
        };
        let refs = mr
            .diff_refs
            .ok_or_else(|| HostError::Protocol("merge request has no diff_refs".to_string()))?;
        Ok(DiffRefs {
            base_sha: refs.base_sha,
            start_sha: refs.start_sha,
            head_sha: refs.head_sha,
        })
    }

    async fn fetch_all_discussions(&self, pr: &PrRef) -> HostResult<Vec<GlDiscussion>> {
        let project = project_id(pr);
        pagination::paginate_all(|page| {
            rest::discussions_page(&self.http, &project, pr.number, page)
        })
        .await
    }

    async fn find_discussion_for_marker(
        &self,
        pr: &PrRef,
        marker: &str,
    ) -> HostResult<Option<(String, u64)>> {
        let tag = marker_tag(marker);
        let discussions = self.fetch_all_discussions(pr).await?;
        for d in &discussions {
            if let Some(note) = d.notes.iter().find(|n| n.body.contains(&tag)) {
                return Ok(Some((d.id.clone(), note.id)));
            }
        }
        Ok(None)
    }

    async fn build_pr_detail(&self, pr: &PrRef, mr: GlMergeRequest) -> HostResult<PrDetail> {
        let project = project_id(pr);
        let iid = pr.number;

        let changes = rest::changes(&self.http, &project, iid).await?;
        let discussions = self.fetch_all_discussions(pr).await?;
        let pipelines = rest::pipelines(&self.http, &project, iid).await?;
        let approvals = rest::approvals(&self.http, &project, iid).await?;
        let commits: Vec<_> =
            pagination::paginate_all(|page| rest::commits_page(&self.http, &project, iid, page))
                .await?;

        let head_sha = Sha::new(mr.sha.clone().unwrap_or_default());

        let (additions, deletions) = diff_stats(&changes.changes);
        let changed_files = changes.changes.len() as u32;

        let checks: Vec<Check> = pipelines.iter().map(map_pipeline).collect();
        let checks_rollup = mr
            .head_pipeline
            .as_ref()
            .map(|p| map_check_rollup(&p.status))
            .unwrap_or(CheckRollup::None);

        let reviewers = map_reviewers(&mr, &approvals);
        let assignees = mr.assignees.iter().map(user_to_person).collect();

        let threads: Vec<Thread> = discussions
            .iter()
            .filter(|d| d.notes.iter().any(|n| !n.system))
            .map(|d| map_thread(d, &head_sha))
            .collect();

        let summary = PrSummary {
            pr: PrRef {
                repo: pr.repo.clone(),
                number: pr.number,
                host_id: Some(mr.project_id.to_string()),
            },
            title: mr.title.clone(),
            author: user_to_person(&mr.author),
            state: pr_state(&mr.state, mr.draft),
            base_ref: mr.target_branch.clone(),
            head_ref: mr.source_branch.clone(),
            head_sha: head_sha.clone(),
            additions,
            deletions,
            changed_files,
            reasons: vec![],
            checks: checks_rollup,
            approvals: approvals.approved_by.len() as u32,
            required_approvals: approvals.approvals_required,
            updated_at: time::parse_millis(&mr.updated_at),
            url: mr.web_url.clone(),
        };

        let base_sha = mr
            .diff_refs
            .as_ref()
            .map(|r| Sha::new(r.base_sha.clone()))
            .unwrap_or_else(|| Sha::new(""));

        Ok(PrDetail {
            summary,
            body: mr.description.clone().unwrap_or_default(),
            base_sha,
            commits: commits.iter().map(map_commit).collect(),
            checks,
            reviewers,
            assignees,
            labels: mr.labels.clone(),
            threads,
            // GitLab has no server-side per-file Viewed (plan §6.4); kept
            // locally by the caller.
            viewed: vec![],
        })
    }
}

#[async_trait]
impl HostAdapter for GitlabAdapter {
    fn kind(&self) -> HostKind {
        HostKind::Gitlab
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            viewed: false,
            pending_review: true,
            suggestions: true,
            resolve_threads: true,
            merge_queue: false,
            auto_merge: true,
            reactions: true,
        }
    }

    async fn viewer(&self) -> HostResult<Person> {
        let u = rest::viewer(&self.http).await?;
        Ok(user_to_person(&u))
    }

    async fn changed_since(&self, cursor: Option<&str>) -> HostResult<Changes> {
        let now = self.clock.now();
        let query = match cursor {
            Some(c) => format!("scope=all&state=opened&updated_after={c}"),
            None => "scope=all&state=opened".to_string(),
        };
        let mrs: Vec<GlMergeRequest> = pagination::paginate_all(|page| {
            rest::list_merge_requests_page(&self.http, &query, page)
        })
        .await?;
        let prs = mrs.iter().filter_map(mr_to_pr_ref).collect();
        Ok(Changes {
            prs,
            cursor: time::format_millis(now),
            poll_after_ms: Some(60_000),
        })
    }

    async fn search(&self, section: &InboxSection) -> HostResult<Vec<PrSummary>> {
        // GitLab has no "mentioned" filter on `/merge_requests`; it tracks
        // that as a to-do instead (plan: "mentions via todos"), so this
        // section bypasses the merge-request listing entirely.
        if matches!(section, InboxSection::Mentioned) {
            let todos: Vec<_> =
                pagination::paginate_all(|page| rest::todos_page(&self.http, page)).await?;
            return Ok(todos
                .iter()
                .map(|t| mr_to_summary(&t.target, Some(InboxReason::Mentioned)))
                .collect());
        }

        let (query, reason) = self.section_query(section).await?;
        let mrs: Vec<GlMergeRequest> = pagination::paginate_all(|page| {
            rest::list_merge_requests_page(&self.http, &query, page)
        })
        .await?;
        Ok(mrs.iter().map(|mr| mr_to_summary(mr, reason)).collect())
    }

    async fn list_repos(&self) -> HostResult<Vec<RepoRef>> {
        let projects =
            pagination::paginate_all(|page| rest::projects_page(&self.http, page)).await?;
        Ok(projects
            .iter()
            .filter_map(|p| {
                let (owner, name) = split_namespace(&p.path_with_namespace)?;
                Some(RepoRef {
                    host: HostKind::Gitlab,
                    owner,
                    name,
                })
            })
            .collect())
    }

    async fn get_pr(&self, pr: &PrRef, etag: Option<&str>) -> HostResult<Fetched<PrDetail>> {
        let project = project_id(pr);
        match rest::get_merge_request(&self.http, &project, pr.number, etag).await? {
            Fetched::NotModified => Ok(Fetched::NotModified),
            Fetched::Modified { etag, value } => {
                let detail = self.build_pr_detail(pr, value).await?;
                Ok(Fetched::Modified {
                    etag,
                    value: detail,
                })
            }
        }
    }

    async fn set_viewed(&self, _pr: &PrRef, _path: &str, _viewed: bool) -> HostResult<()> {
        Err(HostError::Unsupported("set_viewed"))
    }

    async fn submit_review(
        &self,
        pr: &PrRef,
        review: &ReviewSubmission,
    ) -> HostResult<SubmittedReview> {
        let project = project_id(pr);
        let refs = self.fetch_diff_refs(pr).await?;

        for comment in &review.comments {
            let position = anchor::to_position(&comment.anchor, &refs);
            let note = format!("{}\n\n{}", comment.body, marker_tag(&comment.marker));
            rest::create_draft_note(&self.http, &project, pr.number, &note, Some(&position))
                .await?;
        }
        if !review.body.is_empty() {
            rest::create_draft_note(&self.http, &project, pr.number, &review.body, None).await?;
        }
        rest::bulk_publish_draft_notes(&self.http, &project, pr.number).await?;

        if review.event == ReviewEvent::Approve {
            rest::approve(&self.http, &project, pr.number).await?;
        }
        // GitLab has no formal "request changes" review state (plan §6.4
        // deviation): the comments above are posted, approval is simply
        // withheld.

        let mut threads = Vec::new();
        for comment in &review.comments {
            if let Some((discussion_id, _note_id)) =
                self.find_discussion_for_marker(pr, &comment.marker).await?
            {
                threads.push((comment.marker.clone(), ThreadId::new(discussion_id)));
            }
        }

        Ok(SubmittedReview {
            // GitLab has no single "review" resource id; synthesize one.
            review_id: format!("draft-notes:{}", review.commit.as_str()),
            threads,
        })
    }

    async fn find_marker(&self, pr: &PrRef, marker: &str) -> HostResult<Option<CommentId>> {
        Ok(self
            .find_discussion_for_marker(pr, marker)
            .await?
            .map(|(_discussion_id, note_id)| CommentId::new(note_id.to_string())))
    }

    async fn reply(&self, pr: &PrRef, thread: &ThreadId, body: &str) -> HostResult<CommentId> {
        let project = project_id(pr);
        let note =
            rest::reply_to_discussion(&self.http, &project, pr.number, thread.as_str(), body)
                .await?;
        Ok(CommentId::new(note.id.to_string()))
    }

    async fn resolve(&self, pr: &PrRef, thread: &ThreadId, resolved: bool) -> HostResult<()> {
        let project = project_id(pr);
        rest::resolve_discussion(&self.http, &project, pr.number, thread.as_str(), resolved).await
    }

    async fn edit_comment(&self, pr: &PrRef, comment: &CommentId, body: &str) -> HostResult<()> {
        let project = project_id(pr);
        rest::edit_note(&self.http, &project, pr.number, comment.as_str(), body).await
    }

    async fn delete_comment(&self, pr: &PrRef, comment: &CommentId) -> HostResult<()> {
        let project = project_id(pr);
        rest::delete_note(&self.http, &project, pr.number, comment.as_str()).await
    }
}

impl GitlabAdapter {
    /// `InboxSection` -> (`/merge_requests` query string, reason tag).
    /// `Query` is GitLab's one escape hatch: GitLab has no search DSL like
    /// GitHub's, so the string is appended to the query verbatim (e.g.
    /// `"labels=bug&milestone=v2"`), not parsed.
    async fn section_query(
        &self,
        section: &InboxSection,
    ) -> HostResult<(String, Option<InboxReason>)> {
        Ok(match section {
            InboxSection::ReviewRequested => {
                let me = self.username().await?;
                (
                    format!("scope=all&state=opened&reviewer_username={me}"),
                    Some(InboxReason::ReviewRequested),
                )
            }
            InboxSection::Assigned => (
                "scope=assigned_to_me&state=opened".to_string(),
                Some(InboxReason::Assigned),
            ),
            InboxSection::Authored => (
                "scope=created_by_me&state=opened".to_string(),
                Some(InboxReason::Authored),
            ),
            // Handled directly in `search` (no `/merge_requests` query maps
            // to "mentioned"); kept out of this match's return type.
            InboxSection::Mentioned => unreachable!("Mentioned is handled in search()"),
            InboxSection::Query(q) => (format!("state=opened&{q}"), None),
        })
    }
}

fn project_id(pr: &PrRef) -> String {
    match &pr.host_id {
        Some(id) => id.clone(),
        // GitLab accepts a URL-encoded `namespace/path` wherever a numeric
        // project id is expected; `/` is the only character that needs
        // escaping here.
        None => format!("{}/{}", pr.repo.owner, pr.repo.name).replace('/', "%2F"),
    }
}

fn marker_tag(marker: &str) -> String {
    format!("<!-- theodore:{marker} -->")
}

fn user_to_person(u: &GlUser) -> Person {
    Person {
        login: u.username.clone(),
        name: u.name.clone(),
        avatar_url: u.avatar_url.clone(),
    }
}

fn pr_state(state: &str, draft: bool) -> PrState {
    if draft {
        return PrState::Draft;
    }
    match state {
        "merged" => PrState::Merged,
        "closed" | "locked" => PrState::Closed,
        _ => PrState::Open,
    }
}

fn map_check_rollup(status: &str) -> CheckRollup {
    match status {
        "success" => CheckRollup::Pass,
        "failed" | "canceled" => CheckRollup::Fail,
        "running" | "pending" | "created" | "waiting_for_resource" | "preparing" | "scheduled" => {
            CheckRollup::Pending
        }
        _ => CheckRollup::None,
    }
}

fn map_check_status(status: &str) -> CheckStatus {
    match status {
        "success" => CheckStatus::Pass,
        "failed" => CheckStatus::Fail,
        "canceled" | "skipped" => CheckStatus::Skipped,
        _ => CheckStatus::Pending,
    }
}

fn map_pipeline(p: &crate::model::GlPipeline) -> Check {
    Check {
        id: p.id.to_string(),
        name: p.git_ref.clone(),
        status: map_check_status(&p.status),
        url: Some(p.web_url.clone()),
        duration_ms: None,
    }
}

fn map_commit(c: &crate::model::GlCommit) -> Commit {
    Commit {
        sha: Sha::new(c.id.clone()),
        title: c.title.clone(),
        author: Person {
            login: c
                .author_email
                .clone()
                .unwrap_or_else(|| c.author_name.clone()),
            name: Some(c.author_name.clone()),
            avatar_url: None,
        },
        at: time::parse_millis(&c.committed_date),
    }
}

fn map_reviewers(mr: &GlMergeRequest, approvals: &crate::model::GlApprovals) -> Vec<Reviewer> {
    mr.reviewers
        .iter()
        .map(|r| {
            let state = if approvals.approved_by.iter().any(|a| a.user.id == r.id) {
                ReviewerState::Approved
            } else {
                ReviewerState::Requested
            };
            Reviewer {
                person: user_to_person(r),
                state,
                team: None,
            }
        })
        .collect()
}

fn diff_stats(changes: &[crate::model::GlChange]) -> (u32, u32) {
    let mut additions = 0u32;
    let mut deletions = 0u32;
    for c in changes {
        for line in c.diff.lines() {
            if line.starts_with("+++") || line.starts_with("---") {
                continue;
            }
            if line.starts_with('+') {
                additions += 1;
            } else if line.starts_with('-') {
                deletions += 1;
            }
        }
    }
    (additions, deletions)
}

fn map_thread(d: &GlDiscussion, head_sha: &Sha) -> Thread {
    let position = d.notes.iter().find_map(|n| n.position.as_ref());
    let anchor = position.and_then(|p| anchor::from_position(head_sha.clone(), p));
    let outdated = position
        .map(|p| p.head_sha != head_sha.as_str())
        .unwrap_or(false);
    let resolvable_resolved = d
        .notes
        .iter()
        .find(|n| n.resolvable)
        .map(|n| n.resolved)
        .unwrap_or(false);

    let comments = d
        .notes
        .iter()
        .filter(|n| !n.system)
        .map(map_comment)
        .collect();

    Thread {
        id: ThreadId::new(d.id.clone()),
        anchor,
        resolved: resolvable_resolved,
        outdated,
        comments,
    }
}

fn map_comment(n: &GlNote) -> Comment {
    Comment {
        id: CommentId::new(n.id.to_string()),
        author: user_to_person(&n.author),
        body: n.body.clone(),
        created_at: time::parse_millis(&n.created_at),
        edited: n.updated_at != n.created_at,
    }
}

/// `path_with_namespace` ("group/subgroup/project") -> (owner, name).
fn split_namespace(path_with_namespace: &str) -> Option<(String, String)> {
    let (owner, name) = path_with_namespace.rsplit_once('/')?;
    Some((owner.to_string(), name.to_string()))
}

fn mr_to_pr_ref(mr: &GlMergeRequest) -> Option<PrRef> {
    let (owner, name) = parse_namespace_from_web_url(&mr.web_url)?;
    Some(PrRef {
        repo: RepoRef {
            host: HostKind::Gitlab,
            owner,
            name,
        },
        number: mr.iid,
        host_id: Some(mr.project_id.to_string()),
    })
}

fn mr_to_summary(mr: &GlMergeRequest, reason: Option<InboxReason>) -> PrSummary {
    let pr = mr_to_pr_ref(mr).unwrap_or(PrRef {
        repo: RepoRef {
            host: HostKind::Gitlab,
            owner: String::new(),
            name: String::new(),
        },
        number: mr.iid,
        host_id: Some(mr.project_id.to_string()),
    });
    let changed_files = mr
        .changes_count
        .as_deref()
        .and_then(|s| s.trim_end_matches('+').parse().ok())
        .unwrap_or(0);
    PrSummary {
        pr,
        title: mr.title.clone(),
        author: user_to_person(&mr.author),
        state: pr_state(&mr.state, mr.draft),
        base_ref: mr.target_branch.clone(),
        head_ref: mr.source_branch.clone(),
        head_sha: Sha::new(mr.sha.clone().unwrap_or_default()),
        additions: 0,
        deletions: 0,
        changed_files,
        reasons: reason.into_iter().collect(),
        checks: mr
            .head_pipeline
            .as_ref()
            .map(|p| map_check_rollup(&p.status))
            .unwrap_or(CheckRollup::None),
        approvals: 0,
        required_approvals: None,
        updated_at: time::parse_millis(&mr.updated_at),
        url: mr.web_url.clone(),
    }
}

/// Pulls `(owner, name)` out of an MR's `web_url`
/// (`.../<owner>[/<subgroup>...]/<name>/-/merge_requests/<iid>`) — the list
/// and to-do endpoints don't otherwise carry the project's namespace path.
fn parse_namespace_from_web_url(web_url: &str) -> Option<(String, String)> {
    let url = url::Url::parse(web_url).ok()?;
    let path = url.path().trim_start_matches('/');
    let (full_path, _rest) = path.split_once("/-/merge_requests")?;
    split_namespace(full_path)
}
