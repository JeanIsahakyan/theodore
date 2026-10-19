//! First run: turns the scenario into real bare repos (with
//! `refs/pull/<n>/head`), local folder checkouts, and the initial host
//! state. Later runs reuse all of it untouched.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

use theodore_domain::{CheckStatus, Millis, PrState, Side};

use crate::error::{SandboxError, SandboxResult};
use crate::gitops::{self, Bare, Change, Ident, MergeTree};
use crate::scenario::{
    self, CommitSpec, PrStateSpec, ProjectSpec, ReviewerStateSpec, Scenario, SideSpec,
};
use crate::state::{CheckRec, CommentRec, PrRec, ReviewRec, ReviewState, State, ThreadRec};

pub fn remote_dir(root: &Path, owner: &str, name: &str) -> PathBuf {
    root.join("remotes").join(owner).join(format!("{name}.git"))
}

pub fn local_dir(root: &Path, name: &str) -> PathBuf {
    root.join("local").join(name)
}

pub(crate) fn ident(scenario: &Scenario, login: &str) -> Ident {
    let name = scenario
        .users
        .iter()
        .find(|u| u.login == login)
        .and_then(|u| u.name.as_deref());
    Ident::of(login, name)
}

/// Applies one scenario file list on top of `parent`.
pub(crate) fn changes_for(
    bare: &Bare,
    parent: Option<&str>,
    files: &[scenario::FileSpec],
    scenario_dir: &Path,
) -> SandboxResult<Vec<Change>> {
    let mut out = Vec::new();
    for f in files {
        if f.delete {
            out.push(Change::Delete {
                path: f.path.clone(),
            });
            continue;
        }
        let mut bytes = f.content(scenario_dir)?;
        if let Some(from) = &f.rename_from {
            if bytes.is_none() {
                bytes = parent.and_then(|p| bare.read_file(p, from));
            }
            out.push(Change::Delete { path: from.clone() });
        }
        let bytes = bytes.ok_or_else(|| {
            SandboxError::Scenario(format!("{}: no content and nothing to rename", f.path))
        })?;
        out.push(Change::Write {
            path: f.path.clone(),
            bytes,
        });
    }
    Ok(out)
}

/// One commit of a `git fast-import` stream, tracking each branch's files
/// in memory so a rename can carry the old content.
#[allow(clippy::too_many_arguments)]
fn import_commit(
    out: &mut Vec<u8>,
    tree: &mut BTreeMap<String, Vec<u8>>,
    branch: &str,
    mark: u64,
    parent: Option<u64>,
    c: &CommitSpec,
    who: &Ident,
    at: Millis,
    scenario_dir: &Path,
) -> SandboxResult<()> {
    let secs = at.div_euclid(1000);
    out.extend_from_slice(format!("commit refs/heads/{branch}\nmark :{mark}\n").as_bytes());
    for role in ["author", "committer"] {
        out.extend_from_slice(
            format!("{role} {} <{}> {secs} +0000\n", who.name, who.email).as_bytes(),
        );
    }
    out.extend_from_slice(format!("data {}\n{}\n", c.message.len(), c.message).as_bytes());
    if let Some(p) = parent {
        out.extend_from_slice(format!("from :{p}\n").as_bytes());
    }
    for f in &c.files {
        if f.delete {
            tree.remove(&f.path);
            out.extend_from_slice(format!("D {}\n", f.path).as_bytes());
            continue;
        }
        let mut bytes = f.content(scenario_dir)?;
        if let Some(from) = &f.rename_from {
            let old = tree.remove(from);
            bytes = bytes.or(old);
            out.extend_from_slice(format!("D {from}\n").as_bytes());
        }
        let bytes = bytes.ok_or_else(|| {
            SandboxError::Scenario(format!("{}: no content and nothing to rename", f.path))
        })?;
        out.extend_from_slice(
            format!("M 100644 inline {}\ndata {}\n", f.path, bytes.len()).as_bytes(),
        );
        out.extend_from_slice(&bytes);
        out.push(b'\n');
        tree.insert(f.path.clone(), bytes);
    }
    out.push(b'\n');
    Ok(())
}

/// Builds every repo of the scenario that isn't on disk yet, in one
/// `git fast-import` per repo.
pub fn repos(
    scenario: &Scenario,
    scenario_dir: &Path,
    root: &Path,
    epoch: Millis,
) -> SandboxResult<()> {
    for repo in &scenario.repos {
        let dir = remote_dir(root, &repo.owner, &repo.name);
        if dir.join("HEAD").exists() {
            continue;
        }
        let tmp = dir.with_extension("git.partial");
        let _ = std::fs::remove_dir_all(&tmp);
        let bare = Bare::init(&tmp, &repo.default_branch)?;
        let mut stream = Vec::new();
        let mut tips: HashMap<String, u64> = HashMap::new();
        let mut trees: HashMap<String, BTreeMap<String, Vec<u8>>> = HashMap::new();
        let mut mark = 0u64;
        for b in &repo.branches {
            // No `from`: a root branch, or more commits on a branch defined
            // earlier (so `main` can move on after a feature branched off).
            let start = b.from.as_deref().unwrap_or(&b.name);
            let mut parent = tips.get(start).copied();
            let mut tree = trees.get(start).cloned().unwrap_or_default();
            for c in &b.commits {
                mark += 1;
                let at = epoch - scenario::ago(&c.ago)?;
                import_commit(
                    &mut stream,
                    &mut tree,
                    &b.name,
                    mark,
                    parent,
                    c,
                    &ident(scenario, &c.author),
                    at,
                    scenario_dir,
                )?;
                parent = Some(mark);
            }
            let tip = parent.ok_or_else(|| {
                SandboxError::Scenario(format!(
                    "{}: branch {} has no commits and no parent",
                    repo.slug(),
                    b.name
                ))
            })?;
            if b.commits.is_empty() {
                stream.extend_from_slice(
                    format!("reset refs/heads/{}\nfrom :{tip}\n\n", b.name).as_bytes(),
                );
            }
            tips.insert(b.name.clone(), tip);
            trees.insert(b.name.clone(), tree);
        }
        bare.fast_import(&stream)?;
        bare.set_head(&repo.default_branch)?;
        if let Some(parent) = dir.parent() {
            std::fs::create_dir_all(parent).map_err(|e| SandboxError::Io(parent.into(), e))?;
        }
        std::fs::rename(&tmp, &dir).map_err(|e| SandboxError::Io(dir.clone(), e))?;
    }
    Ok(())
}

/// Local folder projects: a working checkout of a scenario repo, with every
/// branch as a local branch and no remote.
pub fn local_folders(scenario: &Scenario, root: &Path) -> SandboxResult<()> {
    for p in &scenario.projects {
        let ProjectSpec::Local { local, from } = p else {
            continue;
        };
        let to = local_dir(root, local);
        if to.join(".git").exists() {
            continue;
        }
        let repo = scenario.repo(from).ok_or_else(|| {
            SandboxError::Scenario(format!("local project {local}: unknown repo {from}"))
        })?;
        let bare = Bare::open(remote_dir(root, &repo.owner, &repo.name));
        gitops::clone_working(&bare, &to)?;
    }
    Ok(())
}

fn review_state(s: ReviewerStateSpec) -> Option<ReviewState> {
    match s {
        ReviewerStateSpec::Requested => None,
        ReviewerStateSpec::Approved => Some(ReviewState::Approved),
        ReviewerStateSpec::ChangesRequested => Some(ReviewState::ChangesRequested),
        ReviewerStateSpec::Commented => Some(ReviewState::Commented),
    }
}

pub(crate) fn side(s: SideSpec) -> Side {
    match s {
        SideSpec::Old => Side::Old,
        SideSpec::New => Side::New,
    }
}

/// The initial host state, after `repos` built the git side. Merged PRs are
/// merged into their base for real here, in scenario order.
pub fn initial_state(scenario: &Scenario, root: &Path, epoch: Millis) -> SandboxResult<State> {
    let mut state = State {
        epoch,
        version: 1,
        next_id: 1000,
        prs: Vec::new(),
        fired: Default::default(),
        faults: scenario.faults.clone(),
        rate_limit_reset_at: None,
        projects_seeded: false,
    };
    let mut refs_cache: HashMap<String, HashMap<String, String>> = HashMap::new();
    for spec in &scenario.prs {
        let repo = scenario
            .repo(&spec.repo)
            .ok_or_else(|| SandboxError::Scenario(format!("unknown repo {}", spec.repo)))?;
        let bare = Bare::open(remote_dir(root, &repo.owner, &repo.name));
        let base_ref = spec
            .base
            .clone()
            .unwrap_or_else(|| repo.default_branch.clone());
        let refs = refs_cache.entry(repo.slug()).or_insert_with(|| bare.refs());
        let head_sha = refs
            .get(&format!("refs/heads/{}", spec.head))
            .cloned()
            .ok_or_else(|| {
                SandboxError::Scenario(format!("PR #{}: no branch {}", spec.number, spec.head))
            })?;
        let base_sha = refs
            .get(&format!("refs/heads/{base_ref}"))
            .cloned()
            .ok_or_else(|| {
                SandboxError::Scenario(format!("PR #{}: no base {base_ref}", spec.number))
            })?;
        bare.update_ref(&format!("refs/pull/{}/head", spec.number), &head_sha)?;

        let last_commit_at = bare
            .log(&base_sha, &head_sha)?
            .last()
            .map(|c| c.at)
            .unwrap_or(epoch);
        let created_at = match &spec.created_ago {
            Some(_) => epoch - scenario::ago(&spec.created_ago)?,
            None => last_commit_at - 60_000,
        };
        let updated_at = match &spec.updated_ago {
            Some(_) => epoch - scenario::ago(&spec.updated_ago)?,
            None => last_commit_at,
        };

        let mut requested_users = Vec::new();
        let mut requested_teams = Vec::new();
        let mut reviews = Vec::new();
        for r in &spec.reviewers {
            match (review_state(r.state), &r.user, &r.team) {
                (None, _, Some(team)) => requested_teams.push(team.clone()),
                (None, Some(user), None) => requested_users.push(user.clone()),
                (Some(st), Some(user), _) => {
                    let id = state.next_id("R");
                    reviews.push(ReviewRec {
                        id,
                        user: user.clone(),
                        state: st,
                        body: r.body.clone(),
                        at: epoch - scenario::ago(&r.ago)?,
                        commit: Some(head_sha.clone()),
                    });
                }
                _ => {
                    return Err(SandboxError::Scenario(format!(
                        "PR #{}: a reviewer needs a user (or a team when requested)",
                        spec.number
                    )));
                }
            }
        }

        let mut checks = Vec::new();
        for c in &spec.checks {
            let id = state.next_id("");
            let transition = match (&c.after, c.then) {
                (Some(after), Some(then)) => Some((epoch + scenario::parse_duration(after)?, then)),
                _ => None,
            };
            checks.push(CheckRec {
                id: id.clone(),
                name: c.name.clone(),
                status: c.status,
                url: c.url.clone().or_else(|| {
                    Some(format!(
                        "https://sandbox.theodore.invalid/{}/checks/{id}",
                        spec.repo
                    ))
                }),
                duration_ms: c
                    .duration_ms
                    .or((c.status != CheckStatus::Pending).then_some(95_000)),
                transition,
            });
        }

        let mut threads = Vec::new();
        for t in &spec.threads {
            let mut comments = Vec::new();
            for c in &t.comments {
                let id = state.next_id("");
                comments.push(CommentRec {
                    id,
                    author: c.author.clone(),
                    body: c.body.clone(),
                    at: epoch - scenario::ago(&c.ago)?,
                    edited: false,
                    reactions: c
                        .reactions
                        .iter()
                        .map(|(e, users)| (e.clone(), users.iter().cloned().collect()))
                        .collect(),
                });
            }
            threads.push(ThreadRec {
                id: state.next_id("SBX_T_"),
                path: t.path.clone(),
                line: t.line,
                side: side(t.side),
                start_line: t.start_line,
                resolved: t.resolved,
                outdated: t.outdated,
                comments,
            });
        }

        let mut rec = PrRec {
            owner: repo.owner.clone(),
            repo: repo.name.clone(),
            number: spec.number,
            node_id: format!("SBX_PR_{}_{}", repo.name, spec.number),
            title: spec.title.clone(),
            body: spec.body.clone(),
            author: spec.author.clone(),
            head_ref: spec.head.clone(),
            base_ref,
            state: match spec.state {
                PrStateSpec::Open => PrState::Open,
                PrStateSpec::Draft => PrState::Draft,
                PrStateSpec::Merged => PrState::Merged,
                PrStateSpec::Closed => PrState::Closed,
            },
            created_at,
            updated_at,
            labels: spec.labels.clone(),
            assignees: spec.assignees.clone(),
            requested_users,
            requested_teams,
            reviews,
            checks,
            threads,
            viewed: Default::default(),
            head_sha: head_sha.clone(),
            frozen: None,
            merged_by: None,
            merge_commit: None,
            auto_merge: None,
            queued_at: None,
            required_approvals: spec.required_approvals,
            version: 1,
        };

        match rec.state {
            PrState::Merged => {
                let author = ident(scenario, &rec.author);
                let sha = merge_commit(
                    &bare,
                    &rec.base_ref,
                    &base_sha,
                    &head_sha,
                    &rec.title,
                    rec.number,
                    &author,
                    updated_at,
                )?;
                rec.frozen = Some((base_sha, head_sha));
                rec.merged_by = Some(rec.author.clone());
                rec.merge_commit = Some(sha);
                refs_cache.remove(&spec.repo);
            }
            PrState::Closed => rec.frozen = Some((base_sha, head_sha)),
            _ => {}
        }
        state.prs.push(rec);
    }
    Ok(state)
}

/// A merge commit of `head` into `base_ref` (at `base_sha`), moving the
/// branch. `Err(Invalid)` on conflicts.
#[allow(clippy::too_many_arguments)]
pub(crate) fn merge_commit(
    bare: &Bare,
    base_ref: &str,
    base_sha: &str,
    head_sha: &str,
    title: &str,
    number: u64,
    author: &Ident,
    at: Millis,
) -> SandboxResult<String> {
    let tree = match bare.merge_tree(base_sha, head_sha, None)? {
        MergeTree::Clean(t) => t,
        MergeTree::Conflicts(paths) => {
            return Err(SandboxError::Invalid(format!(
                "merge conflict in {}",
                paths.join(", ")
            )));
        }
    };
    let message = format!("Merge pull request #{number}\n\n{title}");
    let sha = bare.commit_tree(&tree, &[base_sha, head_sha], &message, author, at)?;
    bare.update_ref(&format!("refs/heads/{base_ref}"), &sha)?;
    Ok(sha)
}
