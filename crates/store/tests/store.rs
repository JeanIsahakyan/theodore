//! Integration tests against the public `Store` trait + `SqliteStore`'s own
//! inherent methods (tx dedup, compaction). Exercises every method at least
//! once, plus concurrency and crash recovery.

use std::sync::Arc;
use std::thread;

use serde_json::json;
use theodore_ports::{
    FleetHostedRow, NewAction, OutboxStatus, Store, StoreError, SyncActionCode, ToolCallKey,
};
use theodore_store::SqliteStore;

fn call(run: &str, call: &str, space: &str) -> ToolCallKey {
    ToolCallKey {
        run: run.into(),
        call: call.into(),
        space: space.into(),
    }
}

#[test]
fn a_tool_payload_builds_up_part_by_part_and_stays_out_of_the_sync_log() {
    let store = SqliteStore::open_in_memory().unwrap();
    let key = call("r1", "c1", "s1");
    store
        .tool_payload_put(&key, "input", &json!({"value": {"command": "ls"}}))
        .unwrap();
    store
        .tool_payload_put(&key, "result", &json!({"ok": true}))
        .unwrap();
    store
        .tool_payload_put(&key, "result", &json!({"ok": false}))
        .unwrap();
    assert_eq!(
        store.tool_payload_get("r1", "c1").unwrap().unwrap(),
        json!({"input": {"value": {"command": "ls"}}, "result": {"ok": false}})
    );
    assert_eq!(store.tool_payload_get("r2", "c1").unwrap(), None);
    assert_eq!(store.last_sync_id().unwrap(), 0);
}

#[test]
fn a_call_id_is_only_unique_within_its_run() {
    let store = SqliteStore::open_in_memory().unwrap();
    store
        .tool_payload_put(&call("r1", "item_0", "s1"), "input", &json!(1))
        .unwrap();
    store
        .tool_payload_put(&call("r2", "item_0", "s1"), "input", &json!(2))
        .unwrap();
    assert_eq!(
        store.tool_payload_get("r1", "item_0").unwrap().unwrap(),
        json!({"input": 1})
    );
    assert_eq!(
        store.tool_payload_get("r2", "item_0").unwrap().unwrap(),
        json!({"input": 2})
    );
}

#[test]
fn pruning_drops_a_spaces_oldest_calls_and_no_other_spaces() {
    let store = SqliteStore::open_in_memory().unwrap();
    let text = json!("x".repeat(1000));
    for i in 0..5 {
        store
            .tool_payload_put(&call("r", &format!("c{i}"), "s1"), "input", &text)
            .unwrap();
    }
    store
        .tool_payload_put(&call("r", "other", "s2"), "input", &text)
        .unwrap();
    assert_eq!(store.tool_payloads_prune("s1", 2500).unwrap(), 3);
    assert!(store.tool_payload_get("r", "c0").unwrap().is_none());
    assert!(store.tool_payload_get("r", "c2").unwrap().is_none());
    assert!(store.tool_payload_get("r", "c3").unwrap().is_some());
    assert!(store.tool_payload_get("r", "c4").unwrap().is_some());
    assert!(store.tool_payload_get("r", "other").unwrap().is_some());
}

#[test]
fn deleting_a_space_takes_its_payloads_with_it() {
    let store = SqliteStore::open_in_memory().unwrap();
    store
        .tool_payload_put(&call("r", "a", "s1"), "input", &json!(1))
        .unwrap();
    store
        .tool_payload_put(&call("r", "b", "s2"), "input", &json!(1))
        .unwrap();
    assert_eq!(store.tool_payloads_delete_space("s1").unwrap(), 1);
    assert!(store.tool_payload_get("r", "a").unwrap().is_none());
    assert!(store.tool_payload_get("r", "b").unwrap().is_some());
}

#[test]
fn a_hosted_fleet_space_is_upserted_and_listed() {
    let store = SqliteStore::open_in_memory().unwrap();
    let mut row = FleetHostedRow {
        space: "rs_1".into(),
        local_space: "s1".into(),
        origin_device: "dev_a".into(),
        parent: None,
        depth: 0,
        created_at: 5,
        data: json!({"turn": 0}),
    };
    store.fleet_hosted_put(&row).unwrap();
    row.data = json!({"turn": 2});
    row.parent = Some("rs_0".into());
    store.fleet_hosted_put(&row).unwrap();
    assert_eq!(store.fleet_hosted_all().unwrap(), vec![row]);
    assert_eq!(store.last_sync_id().unwrap(), 0);
}

#[test]
fn the_fleet_journal_keeps_the_last_events_per_space() {
    let store = SqliteStore::open_in_memory().unwrap();
    for seq in 1..=5 {
        store
            .fleet_journal_append("rs_1", seq, &json!({"n": seq}), 3)
            .unwrap();
    }
    store
        .fleet_journal_append("rs_2", 1, &json!({"n": 1}), 3)
        .unwrap();
    let seqs: Vec<u64> = store
        .fleet_journal_since("rs_1", 0, 10)
        .unwrap()
        .into_iter()
        .map(|(s, _)| s)
        .collect();
    assert_eq!(seqs, vec![3, 4, 5]);
    assert_eq!(
        store.fleet_journal_since("rs_1", 4, 10).unwrap(),
        vec![(5, json!({"n": 5}))]
    );
    assert_eq!(store.fleet_journal_since("rs_2", 0, 10).unwrap().len(), 1);
}

/// Seen fleet requests outlive the process; done never goes back to
/// claiming, and old ones are forgotten.
#[test]
fn fleet_seen_requests_survive_a_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("theodore.db");
    {
        let store = SqliteStore::open(&path).unwrap();
        store.fleet_seen_put("r_old", 100, true, 0).unwrap();
        store.fleet_seen_put("r1", 1_000, false, 0).unwrap();
        store.fleet_seen_put("r1", 1_000, true, 0).unwrap();
        store.fleet_seen_put("r1", 1_000, false, 0).unwrap();
        store.fleet_seen_put("r2", 2_000, false, 500).unwrap();
    }
    let store = SqliteStore::open(&path).unwrap();
    let mut all = store.fleet_seen_all().unwrap();
    all.sort();
    assert_eq!(
        all,
        vec![
            ("r1".to_string(), 1_000, true),
            ("r2".to_string(), 2_000, false)
        ]
    );
}

fn insert(store: &SqliteStore, model: &str, id: &str, data: serde_json::Value) -> u64 {
    let actions = store
        .apply(vec![NewAction {
            model: model.to_string(),
            model_id: id.to_string(),
            action: SyncActionCode::I,
            data: Some(data),
        }])
        .unwrap();
    actions[0].id
}

#[test]
fn insert_then_get() {
    let store = SqliteStore::open_in_memory().unwrap();
    insert(&store, "pr", "1", json!({"title": "hello", "pr": "1"}));

    let row = store.get("pr", "1").unwrap().unwrap();
    assert_eq!(row.model, "pr");
    assert_eq!(row.id, "1");
    assert_eq!(row.data["title"], "hello");
    assert!(!row.archived);

    assert!(store.get("pr", "missing").unwrap().is_none());
}

#[test]
fn full_update_replaces_data() {
    let store = SqliteStore::open_in_memory().unwrap();
    insert(
        &store,
        "pr",
        "1",
        json!({"title": "hello", "body": "keep?"}),
    );

    store
        .apply(vec![NewAction {
            model: "pr".into(),
            model_id: "1".into(),
            action: SyncActionCode::U,
            data: Some(json!({"title": "updated"})),
        }])
        .unwrap();

    let row = store.get("pr", "1").unwrap().unwrap();
    // U is a full replace: the old `body` field is gone.
    assert_eq!(row.data, json!({"title": "updated"}));
}

#[test]
fn merge_patch_changes_only_listed_fields() {
    let store = SqliteStore::open_in_memory().unwrap();
    insert(
        &store,
        "pr",
        "1",
        json!({"title": "hello", "body": "keep", "n": 1}),
    );

    store
        .apply(vec![NewAction {
            model: "pr".into(),
            model_id: "1".into(),
            action: SyncActionCode::C,
            data: Some(json!({"n": 2})),
        }])
        .unwrap();

    let row = store.get("pr", "1").unwrap().unwrap();
    assert_eq!(row.data, json!({"title": "hello", "body": "keep", "n": 2}));
}

#[test]
fn merge_patch_null_removes_a_field() {
    // RFC 7396 semantics, which is what `json_patch` implements.
    let store = SqliteStore::open_in_memory().unwrap();
    insert(
        &store,
        "pr",
        "1",
        json!({"title": "hello", "body": "drop me"}),
    );

    store
        .apply(vec![NewAction {
            model: "pr".into(),
            model_id: "1".into(),
            action: SyncActionCode::C,
            data: Some(json!({"body": null})),
        }])
        .unwrap();

    let row = store.get("pr", "1").unwrap().unwrap();
    assert_eq!(row.data, json!({"title": "hello"}));
}

#[test]
fn merge_patch_on_missing_row_fails() {
    let store = SqliteStore::open_in_memory().unwrap();
    let err = store
        .apply(vec![NewAction {
            model: "pr".into(),
            model_id: "nope".into(),
            action: SyncActionCode::C,
            data: Some(json!({"n": 2})),
        }])
        .unwrap_err();
    assert!(matches!(err, StoreError::Db(_)));
}

#[test]
fn archive_sets_flag_without_touching_data() {
    let store = SqliteStore::open_in_memory().unwrap();
    insert(&store, "pr", "1", json!({"title": "hello"}));

    store
        .apply(vec![NewAction {
            model: "pr".into(),
            model_id: "1".into(),
            action: SyncActionCode::A,
            data: None,
        }])
        .unwrap();

    let row = store.get("pr", "1").unwrap().unwrap();
    assert!(row.archived);
    assert_eq!(row.data["title"], "hello");
}

#[test]
fn delete_removes_the_row() {
    let store = SqliteStore::open_in_memory().unwrap();
    insert(&store, "pr", "1", json!({"title": "hello"}));

    store
        .apply(vec![NewAction {
            model: "pr".into(),
            model_id: "1".into(),
            action: SyncActionCode::D,
            data: None,
        }])
        .unwrap();

    assert!(store.get("pr", "1").unwrap().is_none());
}

#[test]
fn apply_is_one_transaction_and_ids_stay_gap_free_on_rollback() {
    let store = SqliteStore::open_in_memory().unwrap();

    // Second action fails (no such row for a merge patch), so the whole
    // batch — including the otherwise-valid insert — must roll back.
    let err = store
        .apply(vec![
            NewAction {
                model: "pr".into(),
                model_id: "1".into(),
                action: SyncActionCode::I,
                data: Some(json!({"n": 1})),
            },
            NewAction {
                model: "pr".into(),
                model_id: "missing".into(),
                action: SyncActionCode::C,
                data: Some(json!({"n": 2})),
            },
        ])
        .unwrap_err();
    assert!(matches!(err, StoreError::Db(_)));
    assert!(
        store.get("pr", "1").unwrap().is_none(),
        "the insert must not have survived the rollback"
    );
    assert_eq!(store.last_sync_id().unwrap(), 0);

    // A fresh, successful apply gets id 1 — the rolled-back attempt left no
    // permanent gap in the sync log.
    let id = insert(&store, "pr", "1", json!({"n": 1}));
    assert_eq!(id, 1);
}

#[test]
fn apply_with_outbox_rolls_back_the_outbox_push_too() {
    // Mirrors `accept_task`: a model write and an outbox push (e.g.
    // resolve_thread) must land together or not at all.
    let store = SqliteStore::open_in_memory().unwrap();

    let err = store
        .apply_with_outbox(
            vec![NewAction {
                model: "task".into(),
                model_id: "missing".into(),
                action: SyncActionCode::C,
                data: Some(json!({"status": "done"})),
            }],
            "resolve_thread",
            json!({"thread": "t1"}),
        )
        .unwrap_err();
    assert!(matches!(err, StoreError::Db(_)));
    assert!(
        store.outbox_take(0).unwrap().is_none(),
        "the outbox push must not survive a rollback of the model write"
    );
}

#[test]
fn apply_with_outbox_commits_both_halves_together() {
    let store = SqliteStore::open_in_memory().unwrap();
    insert(&store, "task", "t1", json!({"status": "review"}));

    let (applied, outbox_id) = store
        .apply_with_outbox(
            vec![NewAction {
                model: "task".into(),
                model_id: "t1".into(),
                action: SyncActionCode::C,
                data: Some(json!({"status": "done"})),
            }],
            "resolve_thread",
            json!({"thread": "t1"}),
        )
        .unwrap();
    assert_eq!(applied.len(), 1);
    assert_eq!(
        store.get("task", "t1").unwrap().unwrap().data["status"],
        "done"
    );

    let item = store.outbox_take(0).unwrap().expect("outbox item");
    assert_eq!(item.id, outbox_id);
    assert_eq!(item.op, "resolve_thread");
}

#[test]
fn since_and_last_sync_id() {
    let store = SqliteStore::open_in_memory().unwrap();
    insert(&store, "pr", "1", json!({"n": 1}));
    insert(&store, "pr", "2", json!({"n": 2}));
    insert(&store, "pr", "3", json!({"n": 3}));

    assert_eq!(store.last_sync_id().unwrap(), 3);

    let all = store.since(0, 10).unwrap();
    assert_eq!(all.len(), 3);
    assert_eq!(all[0].id, 1);
    assert_eq!(all[2].id, 3);

    let tail = store.since(1, 10).unwrap();
    assert_eq!(tail.len(), 2);
    assert_eq!(tail[0].model_id, "2");

    let limited = store.since(0, 1).unwrap();
    assert_eq!(limited.len(), 1);
    assert_eq!(limited[0].model_id, "1");
}

#[test]
fn query_by_json_field_and_all() {
    let store = SqliteStore::open_in_memory().unwrap();
    insert(&store, "finding", "a", json!({"pr": "42", "title": "a"}));
    insert(&store, "finding", "b", json!({"pr": "42", "title": "b"}));
    insert(&store, "finding", "c", json!({"pr": "7", "title": "c"}));
    insert(&store, "pr", "42", json!({"pr": "42"}));

    let for_42 = store.query("finding", "pr", "42").unwrap();
    assert_eq!(for_42.len(), 2);
    let mut ids: Vec<_> = for_42.iter().map(|r| r.id.clone()).collect();
    ids.sort();
    assert_eq!(ids, vec!["a", "b"]);

    let all_findings = store.all("finding").unwrap();
    assert_eq!(all_findings.len(), 3);
}

#[test]
fn outbox_lifecycle() {
    let store = SqliteStore::open_in_memory().unwrap();
    let id = store
        .outbox_push("post_comment", json!({"body": "hi"}))
        .unwrap();

    let item = store.outbox_take(1_000).unwrap().unwrap();
    assert_eq!(item.id, id);
    assert_eq!(item.status, OutboxStatus::InFlight);
    assert_eq!(item.attempts, 0);
    assert_eq!(item.last_error, None);

    // taken; nothing else pending
    assert!(store.outbox_take(1_000).unwrap().is_none());

    store.outbox_retry(id, 5_000, "network: timed out").unwrap();
    assert!(store.outbox_take(1_000).unwrap().is_none(), "not due yet");
    let retried = store.outbox_take(5_000).unwrap().unwrap();
    assert_eq!(retried.attempts, 1);
    assert_eq!(retried.last_error.as_deref(), Some("network: timed out"));

    store.outbox_done(id).unwrap();
    assert!(store.outbox_take(10_000).unwrap().is_none());
}

#[test]
fn outbox_respects_not_before() {
    let store = SqliteStore::open_in_memory().unwrap();
    let id = store.outbox_push("op", json!({})).unwrap();
    store.outbox_retry(id, 5_000, "x").unwrap();

    assert!(
        store.outbox_take(1_000).unwrap().is_none(),
        "not due until 5000"
    );
    let item = store.outbox_take(5_000).unwrap().unwrap();
    assert_eq!(item.id, id);
}

#[test]
fn outbox_has_pending_matches_op_and_payload_until_taken() {
    let store = SqliteStore::open_in_memory().unwrap();
    let payload = json!({"pr": "p", "path": "a.rs"});
    assert!(!store.outbox_has_pending("set_viewed", &payload).unwrap());
    let id = store.outbox_push("set_viewed", payload.clone()).unwrap();
    assert!(store.outbox_has_pending("set_viewed", &payload).unwrap());
    assert!(
        !store
            .outbox_has_pending("set_viewed", &json!({"pr": "p", "path": "b.rs"}))
            .unwrap()
    );
    assert!(!store.outbox_has_pending("react", &payload).unwrap());

    store.outbox_take(0).unwrap();
    assert!(
        !store.outbox_has_pending("set_viewed", &payload).unwrap(),
        "in flight: its state is already read"
    );
    store.outbox_retry(id, 5_000, "x").unwrap();
    assert!(
        store.outbox_has_pending("set_viewed", &payload).unwrap(),
        "backing off counts as pending"
    );
}

#[test]
fn outbox_fail_stops_retries() {
    let store = SqliteStore::open_in_memory().unwrap();
    let id = store.outbox_push("op", json!({})).unwrap();
    store.outbox_take(0).unwrap();
    assert_eq!(store.outbox_pending_count().unwrap(), 1);
    store
        .outbox_fail(id, "Can not approve your own pull request")
        .unwrap();
    assert!(store.outbox_take(1_000_000).unwrap().is_none());
    assert_eq!(
        store.outbox_pending_count().unwrap(),
        0,
        "a failed item no longer holds is_idle"
    );
}

#[test]
fn outbox_oldest_first() {
    let store = SqliteStore::open_in_memory().unwrap();
    let first = store.outbox_push("op", json!({"n": 1})).unwrap();
    let second = store.outbox_push("op", json!({"n": 2})).unwrap();

    let taken = store.outbox_take(0).unwrap().unwrap();
    assert_eq!(taken.id, first);
    store.outbox_done(first).unwrap();

    let taken = store.outbox_take(0).unwrap().unwrap();
    assert_eq!(taken.id, second);
}

#[test]
fn kv_roundtrip_and_overwrite() {
    let store = SqliteStore::open_in_memory().unwrap();
    assert!(store.kv_get("missing").unwrap().is_none());

    store.kv_set("settings", &json!({"theme": "dark"})).unwrap();
    assert_eq!(
        store.kv_get("settings").unwrap().unwrap(),
        json!({"theme": "dark"})
    );

    store
        .kv_set("settings", &json!({"theme": "light"}))
        .unwrap();
    assert_eq!(
        store.kv_get("settings").unwrap().unwrap(),
        json!({"theme": "light"})
    );
}

#[test]
fn transaction_dedup() {
    let store = SqliteStore::open_in_memory().unwrap();
    assert!(!store.seen_tx("tx-1").unwrap());
    store.mark_tx("tx-1").unwrap();
    assert!(store.seen_tx("tx-1").unwrap());
    // Idempotent.
    store.mark_tx("tx-1").unwrap();
    assert!(store.seen_tx("tx-1").unwrap());
    assert!(!store.seen_tx("tx-2").unwrap());
}

#[test]
fn compaction_keeps_the_log_bounded() {
    let store = SqliteStore::open_in_memory().unwrap();
    for i in 0..5 {
        insert(&store, "pr", &i.to_string(), json!({"n": i}));
    }
    assert_eq!(store.oldest_sync_id().unwrap(), Some(1));

    let removed = store.compact_before(4).unwrap();
    assert_eq!(removed, 3); // ids 1, 2, 3
    assert_eq!(store.oldest_sync_id().unwrap(), Some(4));
    assert_eq!(store.last_sync_id().unwrap(), 5);

    // A client behind the compaction horizon can no longer catch up via
    // `since` — the caller must re-bootstrap it instead.
    let visible = store.since(0, 100).unwrap();
    assert_eq!(visible.first().unwrap().id, 4);
}

fn real_now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

#[test]
fn compact_keeps_everything_when_the_age_window_retains_more_than_the_count() {
    let store = SqliteStore::open_in_memory().unwrap();
    for i in 0..5 {
        insert(&store, "pr", &i.to_string(), json!({"n": i}));
    }
    // Count policy alone would keep only the last 3; the age window is wide
    // enough to cover everything, so the "whichever keeps more" policy must
    // keep all 5 and remove nothing.
    let removed = store.compact(3, i64::MAX / 2, real_now_ms()).unwrap();
    assert_eq!(removed, 0);
    assert_eq!(store.oldest_sync_id().unwrap(), Some(1));
    assert_eq!(store.last_sync_id().unwrap(), 5);
}

#[test]
fn compact_falls_back_to_the_count_policy_when_the_age_window_excludes_everything() {
    let store = SqliteStore::open_in_memory().unwrap();
    for i in 0..5 {
        insert(&store, "pr", &i.to_string(), json!({"n": i}));
    }
    // `now` is far enough ahead that no row's `at` falls inside a
    // zero-width age window; the count policy (keep the last 3) must win
    // instead of the age policy deleting everything.
    let removed = store.compact(3, 0, real_now_ms() + 1_000_000).unwrap();
    assert_eq!(removed, 2); // ids 1, 2
    assert_eq!(store.oldest_sync_id().unwrap(), Some(3));
    assert_eq!(store.last_sync_id().unwrap(), 5);
}

#[test]
fn compact_on_an_empty_log_is_a_no_op() {
    let store = SqliteStore::open_in_memory().unwrap();
    let removed = store
        .compact(10_000, 7 * 24 * 60 * 60 * 1000, real_now_ms())
        .unwrap();
    assert_eq!(removed, 0);
    assert_eq!(store.oldest_sync_id().unwrap(), None);
}

#[test]
fn concurrent_applies_from_several_threads_are_all_persisted_with_unique_ids() {
    let store = Arc::new(SqliteStore::open_in_memory().unwrap());
    let threads = 8;
    let per_thread = 25;

    let handles: Vec<_> = (0..threads)
        .map(|t| {
            let store = Arc::clone(&store);
            thread::spawn(move || {
                for i in 0..per_thread {
                    insert(&store, "item", &format!("{t}-{i}"), json!({"t": t, "i": i}));
                }
            })
        })
        .collect();
    for h in handles {
        h.join().unwrap();
    }

    let total = threads * per_thread;
    assert_eq!(store.last_sync_id().unwrap(), total as u64);
    let rows = store.all("item").unwrap();
    assert_eq!(rows.len(), total);

    let actions = store.since(0, total as u32 + 1).unwrap();
    let mut ids: Vec<_> = actions.iter().map(|a| a.id).collect();
    ids.sort_unstable();
    ids.dedup();
    assert_eq!(ids.len(), total, "every sync id must be unique");
}

#[test]
fn migrating_an_existing_file_leaves_a_working_database() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("theodore.db");

    {
        let store = SqliteStore::open(&path).unwrap();
        insert(&store, "pr", "1", json!({"n": 1}));
    }
    // Reopening re-runs the (now no-op) migration path without data loss.
    let store = SqliteStore::open(&path).unwrap();
    assert_eq!(store.get("pr", "1").unwrap().unwrap().data["n"], 1);
}

#[test]
fn outbox_in_flight_items_recover_as_pending_after_a_crash() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("theodore.db");

    let id = {
        let store = SqliteStore::open(&path).unwrap();
        let id = store.outbox_push("op", json!({})).unwrap();
        // Take it (-> in_flight) and "crash" before marking it done.
        let item = store.outbox_take(0).unwrap().unwrap();
        assert_eq!(item.status, OutboxStatus::InFlight);
        id
    };

    // Reopening the same file simulates a restart after the crash.
    let store = SqliteStore::open(&path).unwrap();
    let recovered = store.outbox_take(0).unwrap().unwrap();
    assert_eq!(recovered.id, id);
    assert_eq!(recovered.status, OutboxStatus::InFlight);
}

#[test]
fn outbox_items_recovered_after_a_crash_count_as_attempted() {
    // A worker may have already landed the op's side effect (e.g. posted a
    // review) right before the process died. If the recovered item still
    // reports `attempts == 0`, op handlers that skip their idempotency-marker
    // check on a "first" attempt would blindly repost it.
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("theodore.db");

    let id = {
        let store = SqliteStore::open(&path).unwrap();
        let id = store.outbox_push("op", json!({})).unwrap();
        let item = store.outbox_take(0).unwrap().unwrap();
        assert_eq!(item.attempts, 0, "a fresh pickup is not yet an attempt");
        id
    };

    let store = SqliteStore::open(&path).unwrap();
    let recovered = store.outbox_take(0).unwrap().unwrap();
    assert_eq!(recovered.id, id);
    assert!(
        recovered.attempts >= 1,
        "an item re-picked after a crash must count as attempted, got {}",
        recovered.attempts
    );
}
