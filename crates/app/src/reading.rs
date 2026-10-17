//! Side effect of reads (plan §3): once every hunk of a file is read, the
//! file becomes locally Viewed and a `set_viewed` outbox item tells the
//! host.

use std::collections::{BTreeSet, HashMap};

use theodore_contract::{FileViewedRow, HunkRead, MutationOp, Transaction, models};
use theodore_domain::{HunkId, PrId, ViewedState};
use theodore_ports::{NewAction, SyncActionCode};

use crate::core::Core;

pub(crate) async fn handle_reads(core: &Core, tx: &Transaction) {
    let mut per_pr: HashMap<PrId, Vec<HunkId>> = HashMap::new();
    for op in &tx.ops {
        if let MutationOp::Create { model, data, .. } = op
            && model == models::HUNK_READ
            && let Ok(hr) = serde_json::from_value::<HunkRead>(data.clone())
        {
            per_pr.entry(hr.pr).or_default().push(hr.hunk);
        }
    }
    for (pr, new_hunks) in per_pr {
        handle_pr_reads(core, &pr, new_hunks).await;
    }
}

async fn handle_pr_reads(core: &Core, pr: &PrId, new_hunks: Vec<HunkId>) {
    let Some(head) = core.0.current_head.read().await.get(pr).cloned() else {
        return;
    };
    let revision = {
        let revisions = core.0.revisions.read().await;
        match revisions.get(&(pr.clone(), head)) {
            Some(e) => e.revision.clone(),
            None => return,
        }
    };

    let store = core.0.deps.store.clone();
    let pr_s = pr.0.clone();
    let rows = match tokio::task::spawn_blocking(move || {
        store.query(models::HUNK_READ, "pr", &pr_s)
    })
    .await
    {
        Ok(Ok(rows)) => rows,
        _ => return,
    };
    let mut after: BTreeSet<HunkId> = BTreeSet::new();
    for row in &rows {
        if let Ok(hr) = serde_json::from_value::<HunkRead>(row.data.clone()) {
            after.insert(hr.hunk);
        }
    }
    let new_set: BTreeSet<HunkId> = new_hunks.into_iter().collect();
    let before: BTreeSet<HunkId> = after.difference(&new_set).cloned().collect();

    let paths = {
        use theodore_domain::reading::{ReadSet, newly_viewed};
        newly_viewed(&revision, &ReadSet(before), &ReadSet(after))
    };
    for path in paths {
        let row_id = format!("{}:{}", pr.0, path);
        let payload = FileViewedRow {
            pr: pr.clone(),
            path: path.clone(),
            state: ViewedState::Viewed,
        };
        let data = serde_json::to_value(&payload).expect("serializable");
        let action = NewAction {
            model: models::FILE_VIEWED.into(),
            model_id: row_id,
            action: SyncActionCode::U,
            data: Some(data),
        };
        let _ = core.apply(vec![action]).await;

        let outbox_payload = serde_json::json!({ "pr": pr.0, "path": path });
        let _ = core.enqueue_outbox("set_viewed", outbox_payload).await;
    }
}
