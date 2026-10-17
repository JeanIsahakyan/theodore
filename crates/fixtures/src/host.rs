//! Fixture host adapter: loads PR data from JSON files.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use sha2::Digest;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use theodore_domain::{CommentId, PrDetail, PrId, PrRef, PrSummary, RepoRef, ThreadId};
use theodore_ports::{
    Capabilities, Changes, Fetched, HostAdapter, HostError, HostResult, InboxSection,
    ReviewSubmission, SubmittedReview,
};

/// Mock call logged by the fixture.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostCall {
    pub method: String,
    pub pr_id: Option<String>,
    pub details: String,
}

/// Fixture host: loads PR data from JSON, tracks calls and modifications.
pub struct FixtureHost {
    #[allow(dead_code)]
    data_dir: std::path::PathBuf,
    state: Mutex<FixtureHostState>,
}

struct FixtureHostState {
    prs: HashMap<PrId, PrDetail>,
    calls: Vec<HostCall>,
    etag_counter: u32,
}

impl FixtureHost {
    /// Create a new fixture host, loading data from the given directory.
    pub async fn new(data_dir: impl AsRef<Path>) -> HostResult<Self> {
        let data_dir = data_dir.as_ref();

        // Load host.json if present
        let mut prs = HashMap::new();
        let host_file = data_dir.join("host").join("prs.json");
        if host_file.exists() {
            let data = tokio::fs::read_to_string(&host_file)
                .await
                .map_err(|e| HostError::Network(e.to_string()))?;
            let pr_list: Vec<PrDetail> =
                serde_json::from_str(&data).map_err(|e| HostError::Protocol(e.to_string()))?;
            for pr in pr_list {
                prs.insert(pr.summary.pr.id(), pr);
            }
        }

        Ok(Self {
            data_dir: data_dir.to_path_buf(),
            state: Mutex::new(FixtureHostState {
                prs,
                calls: Vec::new(),
                etag_counter: 0,
            }),
        })
    }

    /// Get all logged calls.
    pub fn calls(&self) -> Vec<HostCall> {
        self.state.lock().unwrap().calls.clone()
    }

    /// Clear all logged calls.
    pub fn clear_calls(&self) {
        self.state.lock().unwrap().calls.clear();
    }
}

#[async_trait]
impl HostAdapter for FixtureHost {
    fn kind(&self) -> theodore_domain::HostKind {
        theodore_domain::HostKind::Github
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            viewed: true,
            pending_review: true,
            suggestions: true,
            resolve_threads: true,
            merge_queue: false,
            auto_merge: false,
            reactions: false,
        }
    }

    async fn changed_since(&self, cursor: Option<&str>) -> HostResult<Changes> {
        let mut state = self.state.lock().unwrap();
        state.calls.push(HostCall {
            method: "changed_since".to_string(),
            pr_id: None,
            details: format!("cursor={:?}", cursor),
        });

        let prs = state
            .prs
            .values()
            .map(|detail| detail.summary.pr.clone())
            .collect();

        Ok(Changes {
            prs,
            cursor: "fixture-cursor".to_string(),
            poll_after_ms: Some(5000),
        })
    }

    async fn search(&self, section: &InboxSection) -> HostResult<Vec<PrSummary>> {
        let mut state = self.state.lock().unwrap();
        state.calls.push(HostCall {
            method: "search".to_string(),
            pr_id: None,
            details: format!("{:?}", section),
        });

        Ok(state.prs.values().map(|pr| pr.summary.clone()).collect())
    }

    async fn list_repos(&self) -> HostResult<Vec<RepoRef>> {
        let mut state = self.state.lock().unwrap();
        state.calls.push(HostCall {
            method: "list_repos".to_string(),
            pr_id: None,
            details: String::new(),
        });

        let mut repos = Vec::new();
        for pr in state.prs.values() {
            let repo = pr.summary.pr.repo.clone();
            if !repos.iter().any(|r: &RepoRef| r == &repo) {
                repos.push(repo);
            }
        }
        Ok(repos)
    }

    async fn get_pr(&self, pr: &PrRef, etag: Option<&str>) -> HostResult<Fetched<PrDetail>> {
        let pr_id = pr.id();
        let mut state = self.state.lock().unwrap();

        state.calls.push(HostCall {
            method: "get_pr".to_string(),
            pr_id: Some(pr_id.to_string()),
            details: format!("etag={:?}", etag),
        });

        match state.prs.get(&pr_id) {
            Some(detail) => {
                let data = serde_json::to_string(&detail).unwrap_or_default();
                let mut hasher = sha2::Sha256::new();
                hasher.update(data.as_bytes());
                let new_etag = Some(hex::encode(hasher.finalize()));
                Ok(Fetched::Modified {
                    etag: new_etag,
                    value: detail.clone(),
                })
            }
            None => Err(HostError::NotFound(pr_id.to_string())),
        }
    }

    async fn set_viewed(&self, pr: &PrRef, path: &str, viewed: bool) -> HostResult<()> {
        let mut state = self.state.lock().unwrap();
        state.calls.push(HostCall {
            method: "set_viewed".to_string(),
            pr_id: Some(pr.id().to_string()),
            details: format!("path={}, viewed={}", path, viewed),
        });
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

        state.etag_counter += 1;
        let review_id = format!("review-{}", state.etag_counter);

        let threads = review
            .comments
            .iter()
            .enumerate()
            .map(|(i, _)| {
                (
                    format!("marker-{}", i),
                    ThreadId::new(format!("thread-{}", state.etag_counter)),
                )
            })
            .collect();

        Ok(SubmittedReview { review_id, threads })
    }

    async fn find_marker(&self, pr: &PrRef, marker: &str) -> HostResult<Option<CommentId>> {
        let mut state = self.state.lock().unwrap();
        state.calls.push(HostCall {
            method: "find_marker".to_string(),
            pr_id: Some(pr.id().to_string()),
            details: format!("marker={}", marker),
        });
        Ok(None)
    }

    async fn reply(&self, pr: &PrRef, thread: &ThreadId, body: &str) -> HostResult<CommentId> {
        let mut state = self.state.lock().unwrap();
        state.calls.push(HostCall {
            method: "reply".to_string(),
            pr_id: Some(pr.id().to_string()),
            details: format!("thread={}, body_len={}", thread, body.len()),
        });

        state.etag_counter += 1;
        Ok(CommentId::new(format!("comment-{}", state.etag_counter)))
    }

    async fn resolve(&self, pr: &PrRef, thread: &ThreadId, resolved: bool) -> HostResult<()> {
        let mut state = self.state.lock().unwrap();
        state.calls.push(HostCall {
            method: "resolve".to_string(),
            pr_id: Some(pr.id().to_string()),
            details: format!("thread={}, resolved={}", thread, resolved),
        });
        Ok(())
    }

    async fn edit_comment(&self, pr: &PrRef, comment: &CommentId, body: &str) -> HostResult<()> {
        let mut state = self.state.lock().unwrap();
        state.calls.push(HostCall {
            method: "edit_comment".to_string(),
            pr_id: Some(pr.id().to_string()),
            details: format!("comment={}, body_len={}", comment, body.len()),
        });
        Ok(())
    }

    async fn delete_comment(&self, pr: &PrRef, comment: &CommentId) -> HostResult<()> {
        let mut state = self.state.lock().unwrap();
        state.calls.push(HostCall {
            method: "delete_comment".to_string(),
            pr_id: Some(pr.id().to_string()),
            details: format!("comment={}", comment),
        });
        Ok(())
    }
}
