//! Fixture host adapter (`HostAdapter`).
//!
//! Serves the `PrDetail` records loaded into the shared state. Reads never
//! mutate it; writes (`set_viewed`, `reply`, `resolve`, …) do, so a fixture
//! review round-trip looks the same as a real one. `Triggers::author_push`
//! and `Triggers::checks_green` are the other writers (see `triggers.rs`).

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use sha2::Digest;
use theodore_domain::{
    Comment, CommentId, FileViewed, HostRepo, Person, PrDetail, PrRef, PrState, PrSummary, RepoRef,
    Reviewer, ReviewerState, Sha, ThreadId, ViewedState,
};
use theodore_ports::{
    Capabilities, Changes, Fetched, HostAdapter, HostError, HostResult, InboxSection, MergeMethod,
    MergeState, MergeStatus, ReviewSubmission, SubmittedReview,
};

use crate::state::SharedState;

/// One call the host adapter received, for assertions in tests.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostCall {
    pub method: String,
    pub pr_id: Option<String>,
    pub details: String,
}

fn fixture_author() -> Person {
    Person {
        login: "me".to_string(),
        name: None,
        avatar_url: None,
    }
}

/// Fixture host: PR records come from the shared state, mutated only
/// through this adapter's write methods or through `Triggers`.
#[derive(Debug)]
pub struct FixtureHost {
    state: Arc<Mutex<SharedState>>,
}

impl FixtureHost {
    pub(crate) fn new(state: Arc<Mutex<SharedState>>) -> Self {
        Self { state }
    }

    /// Calls received so far, in order, for test assertions.
    pub fn calls(&self) -> Vec<HostCall> {
        self.state.lock().unwrap().calls.clone()
    }

    pub fn clear_calls(&self) {
        self.state.lock().unwrap().calls.clear();
    }

    fn etag_of(detail: &PrDetail) -> String {
        let data = serde_json::to_vec(detail).unwrap_or_default();
        let mut hasher = sha2::Sha256::new();
        hasher.update(&data);
        hex::encode(hasher.finalize())
    }
}

#[async_trait]
impl HostAdapter for FixtureHost {
    fn kind(&self) -> theodore_domain::HostKind {
        theodore_domain::HostKind::Github
    }

    async fn viewer(&self) -> HostResult<theodore_domain::Person> {
        Ok(theodore_domain::Person {
            login: "demo".into(),
            name: Some("Demo Reviewer".into()),
            avatar_url: None,
        })
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            viewed: true,
            pending_review: true,
            suggestions: true,
            resolve_threads: true,
            merge_queue: true,
            auto_merge: true,
            reactions: true,
        }
    }

    async fn changed_since(&self, cursor: Option<&str>) -> HostResult<Changes> {
        let mut state = self.state.lock().unwrap();
        state.calls.push(HostCall {
            method: "changed_since".to_string(),
            pr_id: None,
            details: format!("cursor={cursor:?}"),
        });

        let seq = state.change_log.len();
        let since = cursor
            .and_then(|c| c.strip_prefix("fixture-cursor-"))
            .and_then(|n| n.parse::<usize>().ok());

        let prs = match since {
            Some(n) if n <= seq => state.change_log[n..].to_vec(),
            _ => state.prs.values().map(|d| d.summary.pr.clone()).collect(),
        };

        Ok(Changes {
            prs,
            cursor: format!("fixture-cursor-{seq}"),
            poll_after_ms: Some(5_000),
        })
    }

    async fn search(&self, section: &InboxSection) -> HostResult<Vec<PrSummary>> {
        let mut state = self.state.lock().unwrap();
        state.calls.push(HostCall {
            method: "search".to_string(),
            pr_id: None,
            details: format!("{section:?}"),
        });
        Ok(state.prs.values().map(|pr| pr.summary.clone()).collect())
    }

    async fn list_repos(&self) -> HostResult<Vec<HostRepo>> {
        let mut state = self.state.lock().unwrap();
        state.calls.push(HostCall {
            method: "list_repos".to_string(),
            pr_id: None,
            details: String::new(),
        });

        let mut repos: Vec<RepoRef> = Vec::new();
        for pr in state.prs.values() {
            let repo = pr.summary.pr.repo.clone();
            if !repos.iter().any(|r: &RepoRef| r == &repo) {
                repos.push(repo);
            }
        }
        Ok(repos
            .into_iter()
            .map(|repo| HostRepo {
                repo,
                description: None,
                private: false,
                pushed_at: None,
            })
            .collect())
    }

    async fn get_pr(&self, pr: &PrRef, etag: Option<&str>) -> HostResult<Fetched<PrDetail>> {
        let pr_id = pr.id();
        let mut state = self.state.lock().unwrap();
        state.calls.push(HostCall {
            method: "get_pr".to_string(),
            pr_id: Some(pr_id.to_string()),
            details: format!("etag={etag:?}"),
        });

        let detail = state
            .prs
            .get(&pr_id)
            .cloned()
            .ok_or_else(|| HostError::NotFound(pr_id.to_string()))?;
        let current = Self::etag_of(&detail);
        if etag == Some(current.as_str()) {
            return Ok(Fetched::NotModified);
        }
        Ok(Fetched::Modified {
            etag: Some(current),
            value: detail,
        })
    }

    async fn set_viewed(&self, pr: &PrRef, path: &str, viewed: bool) -> HostResult<()> {
        let pr_id = pr.id();
        let mut state = self.state.lock().unwrap();
        state.calls.push(HostCall {
            method: "set_viewed".to_string(),
            pr_id: Some(pr_id.to_string()),
            details: format!("path={path}, viewed={viewed}"),
        });

        let detail = state
            .prs
            .get_mut(&pr_id)
            .ok_or_else(|| HostError::NotFound(pr_id.to_string()))?;
        let new_state = if viewed {
            ViewedState::Viewed
        } else {
            ViewedState::Unviewed
        };
        match detail.viewed.iter_mut().find(|f| f.path == path) {
            Some(fv) => fv.state = new_state,
            None => detail.viewed.push(FileViewed {
                path: path.to_string(),
                state: new_state,
            }),
        }
        Ok(())
    }

    async fn submit_review(
        &self,
        pr: &PrRef,
        review: &ReviewSubmission,
    ) -> HostResult<SubmittedReview> {
        let pr_id = pr.id();
        let mut state = self.state.lock().unwrap();
        state.calls.push(HostCall {
            method: "submit_review".to_string(),
            pr_id: Some(pr_id.to_string()),
            details: format!(
                "event={:?}, comments={}",
                review.event,
                review.comments.len()
            ),
        });

        let detail = state
            .prs
            .get_mut(&pr_id)
            .ok_or_else(|| HostError::NotFound(pr_id.to_string()))?;

        let mut threads = Vec::with_capacity(review.comments.len());
        for comment in &review.comments {
            let seq = detail.threads.len() + 1;
            let thread_id = ThreadId::new(format!("thread-{}-{seq}", pr_id.as_str()));
            detail.threads.push(theodore_domain::Thread {
                id: thread_id.clone(),
                anchor: Some(comment.anchor.clone()),
                resolved: false,
                outdated: false,
                comments: vec![Comment {
                    id: CommentId::new(format!("comment-{}-{seq}", pr_id.as_str())),
                    author: fixture_author(),
                    body: comment.body.clone(),
                    created_at: 0,
                    edited: false,
                }],
            });
            threads.push((comment.marker.clone(), thread_id));
        }

        let review_id = format!("review-{}-{}", pr_id.as_str(), detail.threads.len());
        Ok(SubmittedReview { review_id, threads })
    }

    async fn find_marker(&self, pr: &PrRef, marker: &str) -> HostResult<Option<CommentId>> {
        let mut state = self.state.lock().unwrap();
        state.calls.push(HostCall {
            method: "find_marker".to_string(),
            pr_id: Some(pr.id().to_string()),
            details: format!("marker={marker}"),
        });
        Ok(None)
    }

    async fn reply(&self, pr: &PrRef, thread: &ThreadId, body: &str) -> HostResult<CommentId> {
        let pr_id = pr.id();
        let mut state = self.state.lock().unwrap();
        state.calls.push(HostCall {
            method: "reply".to_string(),
            pr_id: Some(pr_id.to_string()),
            details: format!("thread={thread}, body_len={}", body.len()),
        });

        let detail = state
            .prs
            .get_mut(&pr_id)
            .ok_or_else(|| HostError::NotFound(pr_id.to_string()))?;
        let t = detail
            .threads
            .iter_mut()
            .find(|t| &t.id == thread)
            .ok_or_else(|| HostError::NotFound(thread.to_string()))?;
        let comment_id = CommentId::new(format!("comment-{}-{}", thread, t.comments.len() + 1));
        t.comments.push(Comment {
            id: comment_id.clone(),
            author: fixture_author(),
            body: body.to_string(),
            created_at: 0,
            edited: false,
        });
        Ok(comment_id)
    }

    async fn resolve(&self, pr: &PrRef, thread: &ThreadId, resolved: bool) -> HostResult<()> {
        let pr_id = pr.id();
        let mut state = self.state.lock().unwrap();
        state.calls.push(HostCall {
            method: "resolve".to_string(),
            pr_id: Some(pr_id.to_string()),
            details: format!("thread={thread}, resolved={resolved}"),
        });

        let detail = state
            .prs
            .get_mut(&pr_id)
            .ok_or_else(|| HostError::NotFound(pr_id.to_string()))?;
        let t = detail
            .threads
            .iter_mut()
            .find(|t| &t.id == thread)
            .ok_or_else(|| HostError::NotFound(thread.to_string()))?;
        t.resolved = resolved;
        Ok(())
    }

    async fn edit_comment(&self, pr: &PrRef, comment: &CommentId, body: &str) -> HostResult<()> {
        let pr_id = pr.id();
        let mut state = self.state.lock().unwrap();
        state.calls.push(HostCall {
            method: "edit_comment".to_string(),
            pr_id: Some(pr_id.to_string()),
            details: format!("comment={comment}, body_len={}", body.len()),
        });

        let detail = state
            .prs
            .get_mut(&pr_id)
            .ok_or_else(|| HostError::NotFound(pr_id.to_string()))?;
        let c = detail
            .threads
            .iter_mut()
            .flat_map(|t| t.comments.iter_mut())
            .find(|c| &c.id == comment)
            .ok_or_else(|| HostError::NotFound(comment.to_string()))?;
        c.body = body.to_string();
        c.edited = true;
        Ok(())
    }

    async fn delete_comment(&self, pr: &PrRef, comment: &CommentId) -> HostResult<()> {
        let pr_id = pr.id();
        let mut state = self.state.lock().unwrap();
        state.calls.push(HostCall {
            method: "delete_comment".to_string(),
            pr_id: Some(pr_id.to_string()),
            details: format!("comment={comment}"),
        });

        let detail = state
            .prs
            .get_mut(&pr_id)
            .ok_or_else(|| HostError::NotFound(pr_id.to_string()))?;
        let mut found = false;
        for t in &mut detail.threads {
            let before = t.comments.len();
            t.comments.retain(|c| &c.id != comment);
            found |= t.comments.len() != before;
        }
        if found {
            Ok(())
        } else {
            Err(HostError::NotFound(comment.to_string()))
        }
    }

    async fn add_reaction(&self, pr: &PrRef, comment: &CommentId, emoji: &str) -> HostResult<()> {
        let mut state = self.state.lock().unwrap();
        state.calls.push(HostCall {
            method: "add_reaction".to_string(),
            pr_id: Some(pr.id().to_string()),
            details: format!("comment={comment}, emoji={emoji}"),
        });
        Ok(())
    }

    async fn remove_reaction(
        &self,
        pr: &PrRef,
        comment: &CommentId,
        emoji: &str,
    ) -> HostResult<()> {
        let mut state = self.state.lock().unwrap();
        state.calls.push(HostCall {
            method: "remove_reaction".to_string(),
            pr_id: Some(pr.id().to_string()),
            details: format!("comment={comment}, emoji={emoji}"),
        });
        Ok(())
    }

    async fn assignable_users(&self, repo: &RepoRef) -> HostResult<Vec<Person>> {
        let mut state = self.state.lock().unwrap();
        state.calls.push(HostCall {
            method: "assignable_users".to_string(),
            pr_id: None,
            details: format!("repo={}", repo.slug()),
        });
        let mut people: Vec<Person> = Vec::new();
        for detail in state.prs.values().filter(|d| &d.summary.pr.repo == repo) {
            for p in std::iter::once(&detail.summary.author)
                .chain(detail.assignees.iter())
                .chain(detail.reviewers.iter().map(|r| &r.person))
            {
                if !people.iter().any(|q| q.login == p.login) {
                    people.push(p.clone());
                }
            }
        }
        Ok(people)
    }

    async fn request_reviewers(
        &self,
        pr: &PrRef,
        users: &[String],
        teams: &[String],
    ) -> HostResult<()> {
        let pr_id = pr.id();
        let mut state = self.state.lock().unwrap();
        state.calls.push(HostCall {
            method: "request_reviewers".to_string(),
            pr_id: Some(pr_id.to_string()),
            details: format!("users={users:?}, teams={teams:?}"),
        });
        let detail = state
            .prs
            .get_mut(&pr_id)
            .ok_or_else(|| HostError::NotFound(pr_id.to_string()))?;
        for login in users {
            if !detail
                .reviewers
                .iter()
                .any(|r| r.person.login == *login && r.team.is_none())
            {
                detail.reviewers.push(Reviewer {
                    person: Person {
                        login: login.clone(),
                        name: None,
                        avatar_url: None,
                    },
                    state: ReviewerState::Requested,
                    team: None,
                });
            }
        }
        for team in teams {
            if !detail
                .reviewers
                .iter()
                .any(|r| r.team.as_deref() == Some(team.as_str()))
            {
                detail.reviewers.push(Reviewer {
                    person: Person {
                        login: team.clone(),
                        name: Some(team.clone()),
                        avatar_url: None,
                    },
                    state: ReviewerState::Requested,
                    team: Some(team.clone()),
                });
            }
        }
        Ok(())
    }

    async fn remove_reviewer(&self, pr: &PrRef, user: &str) -> HostResult<()> {
        let pr_id = pr.id();
        let mut state = self.state.lock().unwrap();
        state.calls.push(HostCall {
            method: "remove_reviewer".to_string(),
            pr_id: Some(pr_id.to_string()),
            details: format!("user={user}"),
        });
        let detail = state
            .prs
            .get_mut(&pr_id)
            .ok_or_else(|| HostError::NotFound(pr_id.to_string()))?;
        detail.reviewers.retain(|r| r.person.login != user);
        Ok(())
    }

    async fn mark_ready(&self, pr: &PrRef) -> HostResult<()> {
        let pr_id = pr.id();
        let mut state = self.state.lock().unwrap();
        state.calls.push(HostCall {
            method: "mark_ready".to_string(),
            pr_id: Some(pr_id.to_string()),
            details: String::new(),
        });
        let detail = state
            .prs
            .get_mut(&pr_id)
            .ok_or_else(|| HostError::NotFound(pr_id.to_string()))?;
        detail.summary.state = PrState::Open;
        Ok(())
    }

    async fn convert_to_draft(&self, pr: &PrRef) -> HostResult<()> {
        let pr_id = pr.id();
        let mut state = self.state.lock().unwrap();
        state.calls.push(HostCall {
            method: "convert_to_draft".to_string(),
            pr_id: Some(pr_id.to_string()),
            details: String::new(),
        });
        let detail = state
            .prs
            .get_mut(&pr_id)
            .ok_or_else(|| HostError::NotFound(pr_id.to_string()))?;
        detail.summary.state = PrState::Draft;
        Ok(())
    }

    async fn update_branch(&self, pr: &PrRef) -> HostResult<()> {
        let pr_id = pr.id();
        let mut state = self.state.lock().unwrap();
        state.calls.push(HostCall {
            method: "update_branch".to_string(),
            pr_id: Some(pr_id.to_string()),
            details: String::new(),
        });
        if !state.prs.contains_key(&pr_id) {
            return Err(HostError::NotFound(pr_id.to_string()));
        }
        Ok(())
    }

    async fn merge_status(&self, pr: &PrRef) -> HostResult<MergeStatus> {
        let pr_id = pr.id();
        let mut state = self.state.lock().unwrap();
        state.calls.push(HostCall {
            method: "merge_status".to_string(),
            pr_id: Some(pr_id.to_string()),
            details: String::new(),
        });
        let detail = state
            .prs
            .get(&pr_id)
            .ok_or_else(|| HostError::NotFound(pr_id.to_string()))?;
        Ok(MergeStatus {
            mergeable: Some(true),
            state: MergeState::Clean,
            allowed_methods: vec![MergeMethod::Merge, MergeMethod::Squash, MergeMethod::Rebase],
            auto_merge_enabled: false,
            in_queue: false,
            required_approvals: detail.summary.required_approvals,
        })
    }

    async fn merge(
        &self,
        pr: &PrRef,
        method: MergeMethod,
        title: Option<String>,
        body: Option<String>,
    ) -> HostResult<Sha> {
        let pr_id = pr.id();
        let mut state = self.state.lock().unwrap();
        state.calls.push(HostCall {
            method: "merge".to_string(),
            pr_id: Some(pr_id.to_string()),
            details: format!(
                "method={method:?}, title={title:?}, body_set={}",
                body.is_some()
            ),
        });
        let detail = state
            .prs
            .get_mut(&pr_id)
            .ok_or_else(|| HostError::NotFound(pr_id.to_string()))?;
        detail.summary.state = PrState::Merged;
        Ok(Sha::new(format!("merged-{}", pr_id.as_str())))
    }

    async fn enable_auto_merge(&self, pr: &PrRef, method: MergeMethod) -> HostResult<()> {
        let mut state = self.state.lock().unwrap();
        state.calls.push(HostCall {
            method: "enable_auto_merge".to_string(),
            pr_id: Some(pr.id().to_string()),
            details: format!("method={method:?}"),
        });
        Ok(())
    }

    async fn disable_auto_merge(&self, pr: &PrRef) -> HostResult<()> {
        let mut state = self.state.lock().unwrap();
        state.calls.push(HostCall {
            method: "disable_auto_merge".to_string(),
            pr_id: Some(pr.id().to_string()),
            details: String::new(),
        });
        Ok(())
    }

    async fn enqueue(&self, pr: &PrRef) -> HostResult<()> {
        let mut state = self.state.lock().unwrap();
        state.calls.push(HostCall {
            method: "enqueue".to_string(),
            pr_id: Some(pr.id().to_string()),
            details: String::new(),
        });
        Ok(())
    }
}
