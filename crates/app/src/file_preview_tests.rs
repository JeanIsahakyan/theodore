//! `file_preview` against `Core` + `testkit`: which commits a chat's file is
//! looked up in, and what each kind of file answers.

use std::time::Duration;

use serde_json::json;
use theodore_contract::{
    AddProjectRequest, CreateSpaceRequest, FilePreview, FilePreviewAnswer, FilePreviewRequest,
    PreviewGap, PreviewSource, Project, Space, SpaceSendRequest, SpaceStatus, models,
};
use theodore_domain::{FileDiff, FileFlag, FileStatus, Sha, Usage};
use theodore_ports::{AgentEvent, Store};

use crate::testkit::{Fixtures, fixtures, line_add, make_hunk};
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

async fn started(f: &Fixtures) -> (Core, Receivers, Project) {
    let (core, recv) = Core::start(f.deps());
    tokio::time::sleep(Duration::from_millis(30)).await;
    let project = core
        .add_project(AddProjectRequest {
            repo: None,
            path: Some("/tmp/my-folder".into()),
        })
        .await
        .expect("add_project");
    wait_until(|| {
        f.store
            .get(models::PROJECT, &project.id)
            .unwrap()
            .is_some_and(|r| r.data["status"] == json!("ready"))
    })
    .await;
    f.git.set_resolve("main", Sha::new("base000"));
    (core, recv, project)
}

fn space(f: &Fixtures, id: &str) -> Space {
    serde_json::from_value(f.store.get(models::SPACE, id).unwrap().unwrap().data).unwrap()
}

/// A space with one finished turn, `base000` to `after1`.
async fn one_turn(f: &Fixtures, core: &Core, project: &Project) -> (Space, String) {
    let s = core
        .create_space(CreateSpaceRequest {
            project: project.id.clone(),
            goal: String::new(),
            name: Some("work".into()),
            branch: None,
            base: None,
            agent: None,
            model: None,
            start_from: None,
            effort: None,
            mode: None,
        })
        .await
        .unwrap();
    f.agents.push_script(vec![AgentEvent::Done {
        final_text: "did it".into(),
        usage: Usage::default(),
    }]);
    f.git.push_checkpoint(Sha::new("after1"));
    core.space_send(SpaceSendRequest {
        space: s.id.clone(),
        text: "go".into(),
        agent: None,
        model: None,
        mode: None,
        attachments: None,
        effort: None,
    })
    .await
    .unwrap();
    wait_until(|| space(f, &s.id).status != SpaceStatus::Running).await;
    let s = space(f, &s.id);
    let reply = s.turn_log[0].reply.clone();
    (s, reply)
}

fn diff_of(path: &str, lines: usize) -> FileDiff {
    let added = (0..lines)
        .map(|n| line_add(n as u32 + 1, &format!("line {n}")))
        .collect();
    FileDiff {
        path: path.into(),
        old_path: None,
        status: FileStatus::Modified,
        similarity: None,
        old_mode: None,
        new_mode: None,
        flags: vec![],
        additions: lines as u32,
        deletions: 0,
        hunks: vec![make_hunk(path, 0, 0, 1, lines as u32, added)],
    }
}

fn in_turn(s: &Space, reply: &str, path: &str) -> FilePreviewRequest {
    FilePreviewRequest {
        source: PreviewSource::Space {
            space: s.id.clone(),
            reply: Some(reply.to_string()),
        },
        path: path.into(),
    }
}

async fn ask(core: &Core, req: FilePreviewRequest) -> FilePreviewAnswer {
    core.file_preview(req).await.unwrap()
}

#[tokio::test]
async fn a_changed_file_is_its_diff_for_that_turn_only() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    let (s, reply) = one_turn(&f, &core, &project).await;
    f.git.put_file_diff(
        &Sha::new("base000"),
        &Sha::new("after1"),
        diff_of("a.rs", 2),
    );

    let got = ask(&core, in_turn(&s, &reply, "a.rs")).await;

    assert!(got.pinned, "a finished turn doesn't change");
    let FilePreview::Diff { file, more_lines } = got.preview else {
        panic!("expected a diff, got {:?}", got.preview);
    };
    assert_eq!(file.path, "a.rs");
    assert_eq!(more_lines, 0);
    assert_eq!(
        f.git.diff_file_calls.lock().unwrap().as_slice(),
        [(Sha::new("base000"), Sha::new("after1"), "a.rs".to_string())],
        "between its checkpoints"
    );
}

#[tokio::test]
async fn a_long_diff_is_cut_and_counts_the_rest() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    let (s, reply) = one_turn(&f, &core, &project).await;
    f.git.put_file_diff(
        &Sha::new("base000"),
        &Sha::new("after1"),
        diff_of("big.rs", 450),
    );

    let FilePreview::Diff { file, more_lines } =
        ask(&core, in_turn(&s, &reply, "big.rs")).await.preview
    else {
        panic!("expected a diff");
    };
    assert_eq!(file.hunks[0].lines.len(), 400);
    assert_eq!(more_lines, 50);
}

#[tokio::test]
async fn a_file_only_read_shows_its_lines_at_that_turn() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    let (s, reply) = one_turn(&f, &core, &project).await;
    f.git
        .put_file(&Sha::new("after1"), "read.md", b"# Title\n\nbody\n");

    let got = ask(&core, in_turn(&s, &reply, "read.md")).await;

    assert!(got.pinned);
    assert_eq!(
        got.preview,
        FilePreview::Text {
            text: "# Title\n\nbody".into(),
            bytes: 14,
            more_lines: 0,
            cut: false,
        }
    );
}

#[tokio::test]
async fn an_image_is_its_bytes_and_binary_or_huge_is_only_a_size() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    let (s, reply) = one_turn(&f, &core, &project).await;
    let after = Sha::new("after1");
    f.git.put_file(&after, "logo.svg", b"<svg/>");
    f.git.put_file(&after, "blob.dat", &[1u8, 0, 2]);
    f.git
        .put_file(&after, "huge.png", &vec![7u8; 5 * 1024 * 1024 + 1]);

    let FilePreview::Image {
        mime,
        base64,
        bytes,
    } = ask(&core, in_turn(&s, &reply, "logo.svg")).await.preview
    else {
        panic!("expected an image");
    };
    assert_eq!(mime, "image/svg+xml");
    assert_eq!(base64, "PHN2Zy8+");
    assert_eq!(bytes, 6);

    assert_eq!(
        ask(&core, in_turn(&s, &reply, "blob.dat")).await.preview,
        FilePreview::Unavailable {
            reason: PreviewGap::Binary,
            bytes: Some(3),
        }
    );
    assert_eq!(
        ask(&core, in_turn(&s, &reply, "huge.png")).await.preview,
        FilePreview::Unavailable {
            reason: PreviewGap::TooLarge,
            bytes: Some(5 * 1024 * 1024 + 1),
        }
    );
}

#[tokio::test]
async fn a_binary_diff_is_no_preview_with_its_new_size() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    let (s, reply) = one_turn(&f, &core, &project).await;
    let mut file = diff_of("a.bin", 0);
    file.hunks.clear();
    file.flags = vec![FileFlag::Binary {
        old_size: Some(10),
        new_size: Some(20),
    }];
    f.git
        .put_file_diff(&Sha::new("base000"), &Sha::new("after1"), file);

    assert_eq!(
        ask(&core, in_turn(&s, &reply, "a.bin")).await.preview,
        FilePreview::Unavailable {
            reason: PreviewGap::Binary,
            bytes: Some(20),
        }
    );
}

#[tokio::test]
async fn a_path_git_cant_name_or_doesnt_have_is_quiet() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    let (s, reply) = one_turn(&f, &core, &project).await;
    let missing = FilePreview::Unavailable {
        reason: PreviewGap::Missing,
        bytes: None,
    };

    for path in ["/etc/passwd", "../outside", "gone.rs"] {
        assert_eq!(
            ask(&core, in_turn(&s, &reply, path)).await.preview,
            missing,
            "{path}"
        );
    }
}

/// While the turn runs nothing is pinned: the worktree can change under it.
#[tokio::test]
async fn a_running_turn_is_the_worktree_since_the_last_checkpoint() {
    let f = fixtures();
    let root = tempfile::tempdir().unwrap();
    f.git.set_space_root(root.path());
    let (core, _recv, project) = started(&f).await;
    let (s, _) = one_turn(&f, &core, &project).await;
    f.git.ship.lock().unwrap().snapshot = Some(Sha::new("live1"));
    f.git
        .put_file_diff(&Sha::new("after1"), &Sha::new("live1"), diff_of("a.rs", 1));

    let got = ask(
        &core,
        FilePreviewRequest {
            source: PreviewSource::Space {
                space: s.id.clone(),
                reply: None,
            },
            path: "a.rs".into(),
        },
    )
    .await;

    assert!(!got.pinned);
    assert!(matches!(got.preview, FilePreview::Diff { .. }));
}

/// A reply with no turn on record falls back to all of the space's change.
#[tokio::test]
async fn a_reply_without_a_checkpoint_is_the_worktree_against_the_base() {
    let f = fixtures();
    let root = tempfile::tempdir().unwrap();
    f.git.set_space_root(root.path());
    let (core, _recv, project) = started(&f).await;
    let (s, _) = one_turn(&f, &core, &project).await;
    f.git.ship.lock().unwrap().snapshot = Some(Sha::new("live2"));
    f.git
        .put_file_diff(&Sha::new("base000"), &Sha::new("live2"), diff_of("a.rs", 1));

    let got = ask(&core, in_turn(&s, "not-a-turn", "a.rs")).await;

    assert!(!got.pinned);
    assert!(matches!(got.preview, FilePreview::Diff { .. }));
}
