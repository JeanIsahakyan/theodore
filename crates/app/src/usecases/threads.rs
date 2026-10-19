//! `reply_thread`, `resolve_thread` (plan §6.5, §6.7): outbox ops over
//! `HostAdapter::reply`/`resolve`. The outbox worker (`outbox.rs`) runs
//! them, refreshing the PR's `pr_detail` on success.

use theodore_contract::{ReplyRequest, ResolveRequest};

use crate::core::Core;
use crate::error::{AppError, AppResult};
use crate::outbox::{ReplyPayload, ResolvePayload};

impl Core {
    pub async fn reply_thread(&self, req: ReplyRequest) -> AppResult<()> {
        let payload = ReplyPayload {
            pr: req.pr,
            thread: req.thread,
            body: req.body,
            marker: uuid::Uuid::new_v4().to_string(),
        };
        let data = serde_json::to_value(&payload).map_err(|e| AppError::Invalid(e.to_string()))?;
        self.enqueue_outbox("reply_thread", data).await?;
        Ok(())
    }

    pub async fn resolve_thread(&self, req: ResolveRequest) -> AppResult<()> {
        let payload = ResolvePayload {
            pr: req.pr,
            thread: req.thread,
            resolved: req.resolved,
        };
        let data = serde_json::to_value(&payload).map_err(|e| AppError::Invalid(e.to_string()))?;
        self.enqueue_outbox("resolve_thread", data).await?;
        Ok(())
    }
}
