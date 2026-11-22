//! Files between devices, this device as the host (docs/fleet.md "Files
//! (blobs)"): attachments of a start, send or send_to land in the space's
//! `.context/` before the turn, refused whole on any failure; `read_file`
//! hands a worktree file back sealed for the origin. A child of
//! `fleet_spaces_tests`, for its harness (real worktrees).

use std::path::{Path, PathBuf};

use theodore_contract::{
    ChatMessage, FleetTrustRequest, QueuedAction, SpaceMode, SpaceQueuedRequest, SpaceSendRequest,
    SpaceStatus, models,
};
use theodore_fleet_protocol::blob::{MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS};
use theodore_fleet_protocol::{
    BlobRef, DeviceKey, DeviceKind, FleetMode, RemoteOp, ReplyOutcome, codes, open_blob, seal_blob,
};
use theodore_ports::{BlobStoreError, Store};

use super::super::{
    ORIGIN, STRANGER, claimed, deliver, done, local_of, my_key, now, refusal, run, sealed,
    sealed_from, space, wait_until,
};
use super::{Host, err_code, host, ok_value, own_space};
use crate::testkit::{FakeBlobCall, Fixtures, fixtures};
use crate::usecases::spaces::space_chat_key;

/// A file sealed for this device, its chunks in the fake cloud store.
fn attach(f: &Fixtures, name: &str, mime: &str, bytes: &[u8]) -> BlobRef {
    let (r, chunks) = seal_blob(&my_key(f), bytes, name, mime).unwrap();
    f.fleet.store_blob(&r.blob_id, chunks);
    r
}

fn send_files(space: &str, message: &str, attachments: Vec<BlobRef>) -> RemoteOp {
    RemoteOp::SendTo {
        space: space.into(),
        message: message.into(),
        attachments,
    }
}

fn start_files(project: &str, space: &str, attachments: Vec<BlobRef>) -> RemoteOp {
    RemoteOp::StartSpace {
        space: space.into(),
        project_id: project.into(),
        goal: "Look at the files".into(),
        mode: FleetMode::Edit,
        agent: None,
        model: None,
        effort: None,
        parent: None,
        depth: 0,
        attachments,
    }
}

fn read_file(space: &str, path: &str, max_bytes: u64) -> RemoteOp {
    RemoteOp::ReadFile {
        space: space.into(),
        path: path.into(),
        max_bytes,
    }
}

fn context_dir(f: &Fixtures, id: &str) -> PathBuf {
    Path::new(&space(f, id).worktree).join(".context")
}

fn chat(f: &Fixtures, id: &str) -> Vec<ChatMessage> {
    f.store
        .query(models::CHAT_MESSAGE, "pr", &space_chat_key(id).0)
        .unwrap()
        .into_iter()
        .map(|r| serde_json::from_value(r.data).unwrap())
        .collect()
}

async fn settled(f: &Fixtures, id: &str, turns: u32) {
    wait_until("settled", || {
        let s = space(f, id);
        s.turns >= turns && s.run.is_none() && s.status != SpaceStatus::Running
    })
    .await;
}

/// A turn of this computer's own running in `id` until the sender fires.
async fn busy(f: &Fixtures, h: &Host, id: &str) -> tokio::sync::oneshot::Sender<()> {
    let go = f.agents.pause_next_run();
    h.core
        .space_send(SpaceSendRequest {
            space: id.into(),
            text: "mine".into(),
            agent: None,
            model: None,
            mode: None,
            attachments: None,
            effort: None,
            mentions: None,
        })
        .await
        .unwrap();
    wait_until("running", || space(f, id).status == SpaceStatus::Running).await;
    go
}

// ── receive ─────────────────────────────────────────────────────────────

#[tokio::test]
async fn attachments_land_in_context_and_reach_the_turn() {
    let f = fixtures();
    let h = host(&f, DeviceKind::Desktop, SpaceMode::Edit).await;
    let own = own_space(&f, &h, "Pick a store", SpaceMode::Edit).await;
    let shot = attach(&f, "shot.png", "image/png", b"png");
    let log = attach(&f, "logs/app.log", "", b"a line\n");
    f.agents.push_script(done("Read them."));
    let value = ok_value(
        run(
            &f,
            &h.key,
            send_files(&own.id, "see the files", vec![shot.clone(), log.clone()]),
        )
        .await,
    );
    assert!(value["message"].is_string(), "{value}");
    settled(&f, &own.id, 2).await;

    // The files, under the worktree's .context, kept out of git.
    let dir = context_dir(&f, &own.id);
    assert_eq!(std::fs::read(dir.join("shot.png")).unwrap(), b"png");
    assert_eq!(std::fs::read(dir.join("app.log")).unwrap(), b"a line\n");
    let excluded = f.git.excluded.lock().unwrap().clone();
    assert!(
        excluded.contains(&format!("{}:/.context/", space(&f, &own.id).worktree)),
        "{excluded:?}"
    );
    // The blobs are gone from the cloud.
    assert!(f.fleet.blob(&shot.blob_id).is_none());
    assert!(f.fleet.blob(&log.blob_id).is_none());
    let calls = f.fleet.blob_calls();
    assert!(calls.contains(&FakeBlobCall::Get {
        blob_id: shot.blob_id.clone(),
        i: 0
    }));
    assert!(calls.contains(&FakeBlobCall::Delete {
        blob_id: log.blob_id.clone()
    }));
    assert_eq!(
        f.fleet.last_blob_access().unwrap().cloud_url,
        super::super::CLOUD
    );
    // The turn: the files listed, the image handed to the agent.
    let req = f.agents.last_request().unwrap();
    assert!(
        req.prompt.ends_with(
            "see the files\n\nAttached files (in .context/): shot.png (image/png, 3 B), \
             app.log (text/plain, 7 B)"
        ),
        "{}",
        req.prompt
    );
    assert_eq!(req.attachments.len(), 1, "{:?}", req.attachments);
    assert_eq!(req.attachments[0].path, dir.join("shot.png"));
    assert_eq!(req.attachments[0].mime, "image/png");
    // The message row carries them, like composer attachments.
    let mine: Vec<ChatMessage> = chat(&f, &own.id)
        .into_iter()
        .filter(|m| m.text == "see the files")
        .collect();
    assert_eq!(mine.len(), 1);
    let names: Vec<&str> = mine[0]
        .attachments
        .iter()
        .map(|a| a.name.as_str())
        .collect();
    assert_eq!(names, ["shot.png", "app.log"]);

    // The same name again: next to the first, never over it.
    let again = attach(&f, "shot.png", "image/png", b"png2");
    f.agents.push_script(done("Again."));
    ok_value(run(&f, &h.key, send_files(&own.id, "again", vec![again])).await);
    settled(&f, &own.id, 3).await;
    assert_eq!(std::fs::read(dir.join("shot.png")).unwrap(), b"png");
    assert_eq!(std::fs::read(dir.join("shot (2).png")).unwrap(), b"png2");
    let req = f.agents.last_request().unwrap();
    assert!(
        req.prompt.contains("shot (2).png (image/png, 4 B)"),
        "{}",
        req.prompt
    );
}

#[tokio::test]
async fn a_bad_attachment_refuses_the_whole_message_and_writes_nothing() {
    let f = fixtures();
    let h = host(&f, DeviceKind::Desktop, SpaceMode::Edit).await;
    let own = own_space(&f, &h, "Pick a store", SpaceMode::Edit).await;
    let turns = space(&f, &own.id).turns;
    let good = attach(&f, "ok.txt", "text/plain", b"fine");

    // Tampered: the chunk doesn't open.
    let bad = attach(&f, "bad.txt", "text/plain", b"original");
    let mut chunks = f.fleet.blob_chunks(&bad.blob_id).unwrap();
    chunks[0][0] ^= 1;
    f.fleet.store_blob(&bad.blob_id, chunks);
    let r = run(
        &f,
        &h.key,
        send_files(&own.id, "x", vec![good.clone(), bad.clone()]),
    )
    .await;
    assert_eq!(err_code(r), codes::ATTACHMENT_FAILED);
    assert!(!context_dir(&f, &own.id).exists(), "nothing written");
    // Not fetched: the good blob is still the sender's to delete.
    assert!(f.fleet.blob(&good.blob_id).is_some());

    // A reference whose digest isn't the plaintext's.
    let (mut lied, chunks) = seal_blob(&my_key(&f), b"real", "lie.txt", "text/plain").unwrap();
    lied.sha256 = "0".repeat(64);
    f.fleet.store_blob(&lied.blob_id, chunks);
    let r = run(&f, &h.key, send_files(&own.id, "x", vec![lied])).await;
    assert_eq!(err_code(r), codes::ATTACHMENT_FAILED);

    // Sealed for another device.
    let other = DeviceKey::generate().unwrap();
    let (theirs, chunks) =
        seal_blob(&other.public_key(), b"not for you", "t.txt", "text/plain").unwrap();
    f.fleet.store_blob(&theirs.blob_id, chunks);
    let r = run(&f, &h.key, send_files(&own.id, "x", vec![theirs])).await;
    assert_eq!(err_code(r), codes::ATTACHMENT_FAILED);

    // Never uploaded, or already gone.
    let (gone, _) = seal_blob(&my_key(&f), b"gone", "g.txt", "text/plain").unwrap();
    let r = run(&f, &h.key, send_files(&own.id, "x", vec![gone])).await;
    assert_eq!(err_code(r), codes::ATTACHMENT_FAILED);

    // The cloud failing on a chunk.
    let flaky = attach(&f, "flaky.txt", "text/plain", b"flaky");
    f.fleet
        .fail_next_gets(vec![BlobStoreError::Other("HTTP 502".into())]);
    let r = run(&f, &h.key, send_files(&own.id, "x", vec![flaky])).await;
    assert_eq!(err_code(r), codes::ATTACHMENT_FAILED);

    assert!(!context_dir(&f, &own.id).exists());
    assert_eq!(space(&f, &own.id).turns, turns, "no turn ran");
    assert_eq!(space(&f, &own.id).status, SpaceStatus::Idle);
}

#[tokio::test]
async fn too_many_or_too_large_attachments_are_refused_before_the_claim() {
    let f = fixtures();
    let h = host(&f, DeviceKind::Desktop, SpaceMode::Edit).await;
    let own = own_space(&f, &h, "Pick a store", SpaceMode::Edit).await;
    let (one, _) = seal_blob(&my_key(&f), b"x", "x.txt", "text/plain").unwrap();

    let many: Vec<BlobRef> = (0..=MAX_ATTACHMENTS)
        .map(|i| BlobRef {
            blob_id: format!("{i:032x}"),
            ..one.clone()
        })
        .collect();
    let (id, env) = sealed(&f, &h.key, send_files(&own.id, "x", many), now(&f));
    deliver(&f, env);
    assert_eq!(refusal(&f, &id).await, codes::TOO_LARGE);
    assert!(!claimed(&f, &id));

    let huge = BlobRef {
        size: MAX_ATTACHMENT_BYTES + 1,
        chunks: 6,
        ..one.clone()
    };
    let (id, env) = sealed(&f, &h.key, send_files(&own.id, "x", vec![huge]), now(&f));
    deliver(&f, env);
    assert_eq!(refusal(&f, &id).await, codes::TOO_LARGE);
    assert!(!claimed(&f, &id));

    // A malformed reference is no attachment either.
    let odd = BlobRef {
        name: "a/b".into(),
        ..one
    };
    let (id, env) = sealed(&f, &h.key, send_files(&own.id, "x", vec![odd]), now(&f));
    deliver(&f, env);
    assert_eq!(refusal(&f, &id).await, codes::ATTACHMENT_FAILED);
    assert!(!claimed(&f, &id));
    assert!(f.fleet.blob_calls().is_empty(), "nothing fetched");
}

#[tokio::test]
async fn a_start_with_attachments_writes_them_before_the_goal_runs() {
    let f = fixtures();
    let h = host(&f, DeviceKind::Desktop, SpaceMode::Edit).await;
    let shot = attach(&f, "design.png", "image/png", b"design");
    f.agents.push_script(done("Built it."));
    let started = ok_value(
        run(
            &f,
            &h.key,
            start_files(&h.project.id, "rs_files", vec![shot.clone()]),
        )
        .await,
    );
    assert_eq!(started["space"], "rs_files");
    let local = local_of(&f, "rs_files");
    settled(&f, &local, 1).await;
    let dir = context_dir(&f, &local);
    assert_eq!(std::fs::read(dir.join("design.png")).unwrap(), b"design");
    assert!(f.fleet.blob(&shot.blob_id).is_none());
    let req = f.agents.last_request().unwrap();
    assert!(
        req.prompt.contains(
            "Look at the files\n\nAttached files (in .context/): design.png (image/png, 6 B)"
        ),
        "{}",
        req.prompt
    );
    assert_eq!(req.attachments.len(), 1);
    assert_eq!(req.attachments[0].path, dir.join("design.png"));
    assert_eq!(req.cwd, Path::new(&space(&f, &local).worktree));
    // The goal itself is kept as asked.
    assert_eq!(space(&f, &local).goal, "Look at the files");

    // A start whose file can't be taken makes no space.
    let (gone, _) = seal_blob(&my_key(&f), b"gone", "g.txt", "text/plain").unwrap();
    let r = run(
        &f,
        &h.key,
        start_files(&h.project.id, "rs_none", vec![gone]),
    )
    .await;
    assert_eq!(err_code(r), codes::ATTACHMENT_FAILED);
    assert!(
        f.store
            .fleet_hosted_all()
            .unwrap()
            .iter()
            .all(|r| r.space != "rs_none")
    );
}

#[tokio::test]
async fn a_queued_send_downloads_at_once_and_a_dropped_one_loses_its_files() {
    let f = fixtures();
    let h = host(&f, DeviceKind::Desktop, SpaceMode::Edit).await;
    let own = own_space(&f, &h, "Pick a store", SpaceMode::Edit).await;
    let go = busy(&f, &h, &own.id).await;

    let first = attach(&f, "first.txt", "text/plain", b"1");
    let value = ok_value(
        run(
            &f,
            &h.key,
            send_files(&own.id, "later", vec![first.clone()]),
        )
        .await,
    );
    assert_eq!(value["queued"], true, "{value}");
    let dir = context_dir(&f, &own.id);
    // Fetched at accept time: there before its turn, gone from the cloud.
    assert_eq!(std::fs::read(dir.join("first.txt")).unwrap(), b"1");
    assert!(f.fleet.blob(&first.blob_id).is_none());
    let queued: Vec<ChatMessage> = chat(&f, &own.id)
        .into_iter()
        .filter(|m| m.queued.is_some())
        .collect();
    assert_eq!(queued.len(), 1);
    assert_eq!(queued[0].attachments[0].name, "first.txt");

    // A second one, cancelled here: its file goes with it.
    let second = attach(&f, "second.txt", "text/plain", b"2");
    ok_value(run(&f, &h.key, send_files(&own.id, "later too", vec![second])).await);
    assert!(dir.join("second.txt").is_file());
    let cancel = chat(&f, &own.id)
        .into_iter()
        .find(|m| m.text == "later too")
        .unwrap();
    h.core
        .space_queued(SpaceQueuedRequest {
            space: own.id.clone(),
            message: cancel.id,
            action: QueuedAction::Cancel,
        })
        .await
        .unwrap();
    assert!(!dir.join("second.txt").exists());
    assert!(dir.join("first.txt").is_file());

    // The origin loses trust while the first waits: dropped when its turn
    // comes, and its file with it.
    h.core
        .fleet_trust_device(FleetTrustRequest {
            device_id: ORIGIN.into(),
            trusted: false,
            public_key: None,
        })
        .await
        .unwrap();
    let _ = go.send(());
    wait_until("the queued message was dropped", || {
        chat(&f, &own.id).iter().any(|m| {
            matches!(
                &m.notice,
                Some(theodore_contract::ChatNotice::RemoteDropped { .. })
            )
        })
    })
    .await;
    wait_until("the file is gone", || !dir.join("first.txt").exists()).await;
    assert!(chat(&f, &own.id).iter().all(|m| m.queued.is_none()));
}

// ── read_file ───────────────────────────────────────────────────────────

#[tokio::test]
async fn read_file_round_trips_a_worktree_file_sealed_for_the_origin() {
    let f = fixtures();
    let h = host(&f, DeviceKind::Desktop, SpaceMode::Edit).await;
    let own = own_space(&f, &h, "Pick a store", SpaceMode::Edit).await;
    let wt = PathBuf::from(&space(&f, &own.id).worktree);
    std::fs::create_dir_all(wt.join("notes")).unwrap();
    let text = "the plan\n".repeat(100);
    std::fs::write(wt.join("notes/plan.txt"), &text).unwrap();
    std::fs::write(wt.join("empty.bin"), b"").unwrap();

    let value = ok_value(run(&f, &h.key, read_file(&own.id, "notes/plan.txt", 1 << 20)).await);
    let blob: BlobRef = serde_json::from_value(value["blob"].clone()).unwrap();
    assert_eq!(blob.name, "plan.txt");
    assert_eq!(blob.mime, "text/plain");
    assert_eq!(blob.size, text.len() as u64);
    assert_eq!(blob.chunks, 1);
    let chunks = f.fleet.blob_chunks(&blob.blob_id).expect("uploaded");
    // Opens with the origin's seed only.
    assert_eq!(
        open_blob(h.key.seed(), &blob, &chunks).unwrap(),
        text.as_bytes()
    );
    let other = DeviceKey::generate().unwrap();
    assert!(open_blob(other.seed(), &blob, &chunks).is_err());
    let calls = f.fleet.blob_calls();
    assert!(calls.contains(&FakeBlobCall::Put {
        blob_id: blob.blob_id.clone(),
        i: 0,
        chunks: 1,
        bytes: chunks[0].len(),
    }));
    let access = f.fleet.last_blob_access().unwrap();
    assert_eq!(access.cloud_url, super::super::CLOUD);
    assert!(!access.access_token.is_empty());
    assert_eq!(space(&f, &own.id).status, SpaceStatus::Idle, "nothing ran");

    // An empty file is one empty chunk.
    let value = ok_value(run(&f, &h.key, read_file(&own.id, "./empty.bin", 10)).await);
    let blob: BlobRef = serde_json::from_value(value["blob"].clone()).unwrap();
    assert_eq!((blob.size, blob.chunks), (0, 1));
    assert_eq!(blob.mime, "application/octet-stream");
    let chunks = f.fleet.blob_chunks(&blob.blob_id).unwrap();
    assert_eq!(open_blob(h.key.seed(), &blob, &chunks).unwrap(), b"");

    // The cloud out of room: refused, nothing half uploaded.
    f.fleet.fail_puts(Some(BlobStoreError::Quota));
    let r = run(&f, &h.key, read_file(&own.id, "notes/plan.txt", 1 << 20)).await;
    assert_eq!(err_code(r), codes::QUOTA);
    assert!(matches!(
        f.fleet.blob_calls().last(),
        Some(FakeBlobCall::Delete { .. })
    ));
}

#[cfg(unix)]
#[tokio::test]
async fn read_file_denies_what_isnt_a_file_inside_the_space() {
    let f = fixtures();
    let h = host(&f, DeviceKind::Desktop, SpaceMode::Edit).await;
    let own = own_space(&f, &h, "Pick a store", SpaceMode::Edit).await;
    let wt = PathBuf::from(&space(&f, &own.id).worktree);
    let outside = wt.parent().unwrap().join("outside.txt");
    std::fs::write(&outside, "secret").unwrap();
    std::fs::create_dir_all(wt.join(".git")).unwrap();
    std::fs::write(wt.join(".git/config"), "[core]").unwrap();
    std::fs::write(wt.join("a.txt"), "aaaa").unwrap();
    std::os::unix::fs::symlink(&outside, wt.join("link.txt")).unwrap();
    std::os::unix::fs::symlink(wt.parent().unwrap(), wt.join("up")).unwrap();

    for bad in [
        "../outside.txt",
        "a/../../outside.txt",
        &outside.display().to_string(),
        "/etc/hosts",
        ".git/config",
        "src/../.git/config",
        "link.txt",
        "up/outside.txt",
        "missing.txt",
        ".",
        "",
    ] {
        let r = run(&f, &h.key, read_file(&own.id, bad, 1 << 20)).await;
        assert_eq!(err_code(r), codes::INVALID, "{bad:?}");
    }
    // Over the asked limit.
    let r = run(&f, &h.key, read_file(&own.id, "a.txt", 3)).await;
    assert_eq!(err_code(r), codes::TOO_LARGE);
    // A space that isn't here.
    let r = run(&f, &h.key, read_file("nope", "a.txt", 10)).await;
    assert_eq!(err_code(r), codes::UNKNOWN_SPACE);
    assert!(
        !f.fleet
            .blob_calls()
            .iter()
            .any(|c| matches!(c, FakeBlobCall::Put { .. })),
        "nothing uploaded"
    );
    // Within bounds, it still works.
    ok_value(run(&f, &h.key, read_file(&own.id, "a.txt", 4)).await);
}

#[tokio::test]
async fn an_untrusted_device_reads_no_file() {
    let f = fixtures();
    let h = host(&f, DeviceKind::Desktop, SpaceMode::Edit).await;
    let own = own_space(&f, &h, "Pick a store", SpaceMode::Edit).await;
    std::fs::write(Path::new(&own.worktree).join("a.txt"), "a").unwrap();
    let stranger = DeviceKey::generate().unwrap();
    let (id, env) = sealed_from(&f, STRANGER, &stranger, read_file(&own.id, "a.txt", 10));
    deliver(&f, env);
    assert_eq!(refusal(&f, &id).await, codes::UNTRUSTED_DEVICE);
    assert!(!claimed(&f, &id));
    let r: ReplyOutcome = run(&f, &h.key, read_file(&own.id, "a.txt", 10)).await;
    ok_value(r);
}
