//! `get_revision` / `get_file` / `get_blob` (plan §3.2): diffs and file
//! contents are immutable per commit, so they're fetched by query, not
//! synced.

use std::path::Path;
use std::sync::Arc;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use theodore_contract::{
    BlobResponse, DiffSide, FileRequest, GetBlobRequest, RevisionRequest, models,
};
use theodore_domain::{HostKind, PrDetail, Revision};
use theodore_ports::DiffOptions;

use crate::core::{Core, RevisionEntry};
use crate::error::{AppError, AppResult};

/// `get_blob` rejects instead of base64-ing a file past this size (plan
/// "image diff"): ~10 MB.
const MAX_BLOB_BYTES: usize = 10 * 1024 * 1024;

impl Core {
    pub async fn get_revision(&self, req: RevisionRequest) -> AppResult<Revision> {
        self.ensure_open(&req.pr).await?;
        if let Some(entry) = self
            .0
            .revisions
            .read()
            .await
            .get(&(req.pr.clone(), req.head.clone()))
        {
            return Ok((*entry.revision).clone());
        }

        let detail = self.load_pr_detail(&req.pr).await?;
        let repo = &detail.summary.pr.repo;
        // Both commits already downloaded: no fetch, which also keeps an
        // earlier head of the PR reviewable offline.
        let repo_path = match self
            .cached_repo_with(repo, &[&detail.base_sha, &req.head])
            .await
        {
            Some(path) => path,
            None if repo.host != HostKind::Local && !self.host_online() => {
                return Err(AppError::OfflineNotCached);
            }
            None => self.0.deps.git.ensure_repo(repo).await?,
        };
        let worktree_path = self.worktree_for(&req, &detail).await?;
        let revision = self
            .0
            .deps
            .git
            .diff(
                &repo_path,
                &detail.base_sha,
                &req.head,
                &DiffOptions::default(),
            )
            .await?;

        self.0.revisions.write().await.insert(
            (req.pr.clone(), req.head.clone()),
            Arc::new(RevisionEntry {
                revision: Arc::new(revision.clone()),
                repo_path,
                worktree_path,
                base: crate::usecases::review_config::ConfigBase::of(&detail.summary.pr, &detail),
                pr_ref: detail.summary.pr,
            }),
        );
        Ok(revision)
    }

    /// The PR's one worktree, checked out at `req.head` only when that is
    /// the PR's current head. Agents, grouping, skills and the repo config
    /// all read that worktree as "the head": an older revision (the
    /// review's "since last visit" baseline, loaded alongside the head) is
    /// diffed in the bare repo and must not move it.
    ///
    /// ```text
    /// get_revision(head)     ─▶ worktree @ head ─▶ diff
    /// get_revision(baseline) ─────────────────────▶ diff   (worktree stays @ head)
    /// ```
    async fn worktree_for(
        &self,
        req: &RevisionRequest,
        detail: &PrDetail,
    ) -> AppResult<std::path::PathBuf> {
        let pr_ref = &detail.summary.pr;
        let current = self.0.current_head.read().await.get(&req.pr).cloned();
        let at = match current {
            Some(current) if current != req.head => {
                let known = self
                    .0
                    .revisions
                    .read()
                    .await
                    .get(&(req.pr.clone(), current.clone()))
                    .map(|e| e.worktree_path.clone());
                if let Some(path) = known {
                    return Ok(path);
                }
                current
            }
            _ => req.head.clone(),
        };
        Ok(self.0.deps.git.worktree(pr_ref, &at).await?.path)
    }

    pub async fn get_file(&self, req: FileRequest) -> AppResult<Option<String>> {
        self.ensure_open(&req.pr).await?;
        let repo_path = {
            let revisions = self.0.revisions.read().await;
            revisions
                .iter()
                .find(|((pr, _), _)| *pr == req.pr)
                .map(|(_, e)| e.repo_path.clone())
        };
        let repo_path = match repo_path {
            Some(p) => p,
            None => {
                let detail = self.load_pr_detail(&req.pr).await?;
                self.0.deps.git.ensure_repo(&detail.summary.pr.repo).await?
            }
        };
        let bytes = self
            .0
            .deps
            .git
            .show(&repo_path, &req.rev, &req.path)
            .await?;
        Ok(bytes.map(|b| String::from_utf8_lossy(&b).into_owned()))
    }

    /// Raw bytes of `req.path` at `req.side` (plan "image diff"), base64'd
    /// for a `data:` URL. Capped at `MAX_BLOB_BYTES`: the UI shows "too
    /// large to preview" instead of hanging on a multi-megabyte encode.
    pub async fn get_blob(&self, req: GetBlobRequest) -> AppResult<BlobResponse> {
        self.ensure_open(&req.pr).await?;
        let detail = self.load_pr_detail(&req.pr).await?;
        let repo_path = {
            let revisions = self.0.revisions.read().await;
            revisions
                .iter()
                .find(|((pr, _), _)| *pr == req.pr)
                .map(|(_, e)| e.repo_path.clone())
        };
        let repo_path = match repo_path {
            Some(p) => p,
            None => self.0.deps.git.ensure_repo(&detail.summary.pr.repo).await?,
        };
        let sha = match req.side {
            DiffSide::Base => detail.base_sha.clone(),
            DiffSide::Head => self
                .0
                .current_head
                .read()
                .await
                .get(&req.pr)
                .cloned()
                .unwrap_or_else(|| detail.summary.head_sha.clone()),
        };
        let bytes = self
            .0
            .deps
            .git
            .show(&repo_path, &sha, &req.path)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("{} at {sha}", req.path)))?;
        if bytes.len() > MAX_BLOB_BYTES {
            return Err(AppError::Invalid(format!(
                "{} is {} bytes, over the {MAX_BLOB_BYTES}-byte preview cap",
                req.path,
                bytes.len(),
            )));
        }
        Ok(BlobResponse {
            mime: mime_for(&req.path).to_string(),
            bytes: bytes.len() as u64,
            base64: BASE64.encode(&bytes),
        })
    }

    pub(crate) async fn load_pr_detail(&self, pr: &theodore_domain::PrId) -> AppResult<PrDetail> {
        let pr_s = pr.0.clone();
        let store = self.0.deps.store.clone();
        let row = tokio::task::spawn_blocking(move || store.get(models::PR_DETAIL, &pr_s))
            .await
            .map_err(AppError::join)??;
        let Some(row) = row else {
            return Err(AppError::NotFound(format!("pr {pr}")));
        };
        serde_json::from_value(row.data).map_err(|e| AppError::Invalid(e.to_string()))
    }
}

/// Image mime type from a path's extension (plan "image diff"); anything
/// else is treated as opaque binary — `get_blob` is only ever called for a
/// path the UI already recognized as an image.
fn mime_for(path: &str) -> &'static str {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::mime_for;

    #[test]
    fn mime_for_known_image_extensions() {
        assert_eq!(mime_for("a/b.png"), "image/png");
        assert_eq!(mime_for("a/b.JPG"), "image/jpeg");
        assert_eq!(mime_for("a/b.jpeg"), "image/jpeg");
        assert_eq!(mime_for("a/b.gif"), "image/gif");
        assert_eq!(mime_for("a/b.webp"), "image/webp");
        assert_eq!(mime_for("a/b.svg"), "image/svg+xml");
        assert_eq!(mime_for("a/b.ico"), "image/x-icon");
    }

    #[test]
    fn mime_for_unknown_extension_is_octet_stream() {
        assert_eq!(mime_for("a/b.psd"), "application/octet-stream");
        assert_eq!(mime_for("no_extension"), "application/octet-stream");
    }
}
