//! Projects (plan "projects"): connected repositories — a host repo cloned
//! bare under the cache, or a local folder mirrored into it without ever
//! writing to the folder's own `.git` — and reviewing one of their branches
//! without a host PR.

use std::path::Path;

use theodore_contract::{
    AddProjectRequest, Ephemeral, LocalBranch, OpenBranchRequest, Project, ProjectStatus,
    ToastLevel, models,
};
use theodore_domain::{HostKind, HostRepo, PrDetail, PrId, PrRef, PrSummary, RepoRef};
use theodore_ports::{InboxSection, NewAction, SyncActionCode};

use crate::core::Core;
use crate::error::{AppError, AppResult};

impl Core {
    pub async fn list_host_repos(&self) -> AppResult<Vec<HostRepo>> {
        Ok(self.0.deps.host.list_repos().await?)
    }

    pub async fn add_project(&self, req: AddProjectRequest) -> AppResult<Project> {
        let (id, repo, path) = match (req.repo, req.path) {
            (Some(_), Some(_)) | (None, None) => {
                return Err(AppError::Invalid(
                    "add_project needs exactly one of repo or path".into(),
                ));
            }
            (Some(repo), None) => (project_id_for_repo(&repo), repo, None),
            (None, Some(path)) => {
                let folder = Path::new(&path)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("project")
                    .to_string();
                if !self.0.deps.git.is_repo(Path::new(&path)).await? {
                    return Err(AppError::Invalid(format!("{path} is not a git repository")));
                }
                let name = self.unique_local_name(&folder).await?;
                let repo = RepoRef {
                    host: HostKind::Local,
                    owner: "local".into(),
                    name: name.clone(),
                };
                (format!("local:{name}"), repo, Some(path))
            }
        };

        if self.project_row(&id).await?.is_some() {
            return Err(AppError::Invalid(format!("project {id} already added")));
        }

        let project = Project {
            id: id.clone(),
            repo: repo.clone(),
            path: path.clone(),
            status: ProjectStatus::Cloning,
            error: None,
            default_branch: None,
            added_at: self.0.deps.clock.now(),
        };
        self.apply(vec![NewAction {
            model: models::PROJECT.into(),
            model_id: id.clone(),
            action: SyncActionCode::I,
            data: Some(
                serde_json::to_value(&project).map_err(|e| AppError::Invalid(e.to_string()))?,
            ),
        }])
        .await?;

        self.spawn_project_clone(id, repo, path);
        Ok(project)
    }

    pub async fn remove_project(&self, id: &str) -> AppResult<()> {
        let project = self
            .project_row(id)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("project {id}")))?;
        // Best-effort: the project row is still removed even if the cache
        // was already gone. `path` (a local folder) is never touched.
        let _ = self.0.deps.git.remove_repo(&project.repo).await;
        self.apply(vec![NewAction {
            model: models::PROJECT.into(),
            model_id: id.into(),
            action: SyncActionCode::D,
            data: None,
        }])
        .await?;
        Ok(())
    }

    /// Fetches/refreshes the project's cache, keeps `default_branch` fresh,
    /// and — for a host project — writes its open PRs as `pr` rows.
    pub async fn refresh_project(&self, id: &str) -> AppResult<()> {
        let project = self
            .project_row(id)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("project {id}")))?;
        let repo_path = self.ensure_project_cache(&project).await?;

        if let Ok(Some(default_branch)) = self.0.deps.git.default_branch(&repo_path).await
            && project.default_branch.as_deref() != Some(default_branch.as_str())
        {
            self.apply(vec![NewAction {
                model: models::PROJECT.into(),
                model_id: id.into(),
                action: SyncActionCode::C,
                data: Some(serde_json::json!({ "default_branch": default_branch })),
            }])
            .await?;
        }

        if project.repo.host != HostKind::Local {
            let query = format!("is:pr is:open repo:{}", project.repo.slug());
            match self
                .0
                .deps
                .host
                .search_repo(&project.repo, &InboxSection::Query(query))
                .await
            {
                Ok(summaries) => {
                    let mut actions = Vec::with_capacity(summaries.len());
                    for summary in summaries {
                        let data = serde_json::to_value(&summary)
                            .map_err(|e| AppError::Invalid(e.to_string()))?;
                        actions.push(NewAction {
                            model: models::PR.into(),
                            model_id: summary.pr.id().0,
                            action: SyncActionCode::U,
                            data: Some(data),
                        });
                    }
                    self.apply(actions).await?;
                }
                Err(e) => {
                    self.emit(Ephemeral::Toast {
                        level: ToastLevel::Warn,
                        text: format!("project refresh failed: {e}"),
                    });
                }
            }
        }
        Ok(())
    }

    pub async fn list_branches(&self, project: &str) -> AppResult<Vec<LocalBranch>> {
        let project = self
            .project_row(project)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("project {project}")))?;
        let repo_path = self.ensure_project_cache(&project).await?;
        let default_branch = project.default_branch.clone().unwrap_or_default();
        let branches = self
            .0
            .deps
            .git
            .list_branches(&repo_path, &default_branch)
            .await?;
        Ok(branches
            .into_iter()
            .map(|b| LocalBranch {
                name: b.name,
                head: b.head,
                subject: b.subject,
                ahead: b.ahead,
                behind: b.behind,
                updated_at: b.updated_at,
            })
            .collect())
    }

    pub async fn open_branch(
        &self,
        req: OpenBranchRequest,
    ) -> AppResult<theodore_contract::OpenPrResponse> {
        let project = self
            .project_row(&req.project)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("project {}", req.project)))?;
        let base = req
            .base
            .clone()
            .or_else(|| project.default_branch.clone())
            .ok_or_else(|| {
                AppError::Invalid(format!("project {} has no default branch yet", project.id))
            })?;
        let number = stable_hash_u32(&req.branch) as u64;
        let pr_ref = PrRef {
            repo: project.repo.clone(),
            number,
            host_id: Some(req.branch.clone()),
        };

        let _guard = self.0.open_lock.lock().await;
        let id = pr_ref.id();
        if let Some(head) = self.0.current_head.read().await.get(&id).cloned() {
            return Ok(theodore_contract::OpenPrResponse { pr: id, head });
        }
        self.open_local(&project, pr_ref, &base).await
    }

    /// Recovers a `local:` PR's `PrRef` (branch, base) from its stored `pr`
    /// row and runs the same flow `open_branch` would.
    pub(crate) async fn ensure_open_local(&self, pr: &PrId) -> AppResult<()> {
        let row = self
            .get_row(models::PR, &pr.0)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("pr {pr}")))?;
        let summary: PrSummary =
            serde_json::from_value(row).map_err(|e| AppError::Invalid(e.to_string()))?;
        let pr_ref = summary.pr;
        let project_id = project_id_for_repo(&pr_ref.repo);
        let project = self
            .project_row(&project_id)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("project {project_id}")))?;
        self.open_local(&project, pr_ref, &summary.base_ref)
            .await
            .map(|_| ())
    }

    async fn open_local(
        &self,
        project: &Project,
        pr_ref: PrRef,
        base: &str,
    ) -> AppResult<theodore_contract::OpenPrResponse> {
        let branch = pr_ref
            .host_id
            .clone()
            .ok_or_else(|| AppError::Invalid("local PR is missing its branch".into()))?;
        let repo_path = self.ensure_project_cache(project).await?;
        let (detail, revision): (PrDetail, theodore_domain::Revision) = self
            .0
            .deps
            .git
            .describe_branch(&repo_path, &pr_ref.repo, pr_ref.number, &branch, base)
            .await?;
        let head = detail.summary.head_sha.clone();
        let worktree = self.0.deps.git.worktree(&pr_ref, &head).await?;
        self.finish_open(pr_ref, detail, revision, repo_path, worktree.path)
            .await
    }

    /// Resumes a mirror/clone that was still `cloning` when Theodore last
    /// shut down.
    pub async fn resume_cloning_projects(&self) -> AppResult<()> {
        let store = self.0.deps.store.clone();
        let rows = tokio::task::spawn_blocking(move || store.all(models::PROJECT))
            .await
            .map_err(AppError::join)??;
        for row in rows {
            let Ok(project) = serde_json::from_value::<Project>(row.data) else {
                continue;
            };
            if project.status == ProjectStatus::Cloning {
                self.spawn_project_clone(project.id, project.repo, project.path);
            }
        }
        Ok(())
    }

    fn spawn_project_clone(&self, id: String, repo: RepoRef, path: Option<String>) {
        let core = self.clone();
        tokio::spawn(async move {
            let result: AppResult<String> = async {
                let repo_path = match &path {
                    Some(path) => {
                        core.0
                            .deps
                            .git
                            .ensure_local_mirror(Path::new(path), &repo)
                            .await?
                    }
                    None => core.0.deps.git.ensure_repo(&repo).await?,
                };
                let default_branch = core.0.deps.git.default_branch(&repo_path).await?;
                Ok(default_branch.unwrap_or_else(|| "main".into()))
            }
            .await;

            match result {
                Ok(default_branch) => {
                    let _ = core
                        .apply(vec![NewAction {
                            model: models::PROJECT.into(),
                            model_id: id.clone(),
                            action: SyncActionCode::C,
                            data: Some(serde_json::json!({
                                "status": ProjectStatus::Ready,
                                "default_branch": default_branch,
                                "error": null,
                            })),
                        }])
                        .await;
                    if let Err(e) = core.refresh_project(&id).await {
                        core.emit(Ephemeral::Toast {
                            level: ToastLevel::Warn,
                            text: format!("project refresh failed: {e}"),
                        });
                    }
                }
                Err(e) => {
                    let _ = core
                        .apply(vec![NewAction {
                            model: models::PROJECT.into(),
                            model_id: id,
                            action: SyncActionCode::C,
                            data: Some(serde_json::json!({
                                "status": ProjectStatus::Error,
                                "error": e.to_string(),
                            })),
                        }])
                        .await;
                }
            }
        });
    }

    /// Recovery path for the poller (plan "projects"): resolves a `Local`
    /// `RepoRef` back to its project's cache when the revision cache has
    /// nothing for it (e.g. after a restart).
    pub(crate) async fn ensure_local_project_cache(
        &self,
        repo: &RepoRef,
    ) -> theodore_ports::GitResult<std::path::PathBuf> {
        let id = project_id_for_repo(repo);
        let project = self.project_row(&id).await.ok().flatten();
        let Some(project) = project else {
            return Err(theodore_ports::GitError::Unsupported(
                "unknown local project",
            ));
        };
        self.ensure_project_cache(&project)
            .await
            .map_err(|e| theodore_ports::GitError::Parse(e.to_string()))
    }

    async fn ensure_project_cache(&self, project: &Project) -> AppResult<std::path::PathBuf> {
        Ok(match &project.path {
            Some(path) => {
                self.0
                    .deps
                    .git
                    .ensure_local_mirror(Path::new(path), &project.repo)
                    .await?
            }
            None => self.0.deps.git.ensure_repo(&project.repo).await?,
        })
    }

    pub(crate) async fn project_row(&self, id: &str) -> AppResult<Option<Project>> {
        match self.get_row(models::PROJECT, id).await? {
            Some(data) => Ok(Some(
                serde_json::from_value(data).map_err(|e| AppError::Invalid(e.to_string()))?,
            )),
            None => Ok(None),
        }
    }

    pub(crate) async fn get_row(
        &self,
        model: &str,
        id: &str,
    ) -> AppResult<Option<serde_json::Value>> {
        let store = self.0.deps.store.clone();
        let (model, id) = (model.to_string(), id.to_string());
        let row = tokio::task::spawn_blocking(move || store.get(&model, &id))
            .await
            .map_err(AppError::join)??;
        Ok(row.map(|r| r.data))
    }

    async fn unique_local_name(&self, folder: &str) -> AppResult<String> {
        let store = self.0.deps.store.clone();
        let rows = tokio::task::spawn_blocking(move || store.all(models::PROJECT))
            .await
            .map_err(AppError::join)??;
        let existing: std::collections::HashSet<String> = rows
            .into_iter()
            .filter_map(|r| serde_json::from_value::<Project>(r.data).ok())
            .filter(|p| p.repo.host == HostKind::Local)
            .map(|p| p.repo.name)
            .collect();
        if !existing.contains(folder) {
            return Ok(folder.to_string());
        }
        for n in 2.. {
            let candidate = format!("{folder}-{n}");
            if !existing.contains(&candidate) {
                return Ok(candidate);
            }
        }
        unreachable!()
    }
}

fn project_id_for_repo(repo: &RepoRef) -> String {
    match repo.host {
        // A local project's id is `local:<name>`, not `local:local/<name>`
        // — `owner` is always the literal "local", it isn't part of the id.
        HostKind::Local => format!("local:{}", repo.name),
        HostKind::Github => format!("github:{}", repo.slug()),
        HostKind::Gitlab => format!("gitlab:{}", repo.slug()),
        HostKind::Bitbucket => format!("bitbucket:{}", repo.slug()),
    }
}

/// Deterministic across restarts (unlike `DefaultHasher`, whose seed is
/// randomized per process) — FNV-1a over the branch name.
fn stable_hash_u32(s: &str) -> u32 {
    let mut hash: u32 = 0x811c_9dc5;
    for b in s.as_bytes() {
        hash ^= *b as u32;
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_hash_is_deterministic() {
        assert_eq!(stable_hash_u32("feature/x"), stable_hash_u32("feature/x"));
        assert_ne!(stable_hash_u32("feature/x"), stable_hash_u32("feature/y"));
    }

    #[test]
    fn project_id_matches_the_contract_doc_comment() {
        let repo = RepoRef {
            host: HostKind::Github,
            owner: "acme".into(),
            name: "widgets".into(),
        };
        assert_eq!(project_id_for_repo(&repo), "github:acme/widgets");
    }
}
