//! A blank space (docs/spaces.md §3 "New space"): created with nothing to
//! start from, its worktree ready, called "New space" until the chat
//! starts.
//!
//! ```text
//! create, empty form ─▶ worktree, setup ─▶ goal "", title "New space",
//!                                          branch <login>/new-space-<id>
//! first message  ─ words ──────▶ goal = the text, title cleared ─▶ naming (once)
//!                └ files only ─▶ title = the first file's name, still blank:
//!                                the first words still name it
//! ```
//!
//! A turn Theodore starts itself (`system_send`) isn't the first message.

use std::path::PathBuf;

use theodore_contract::{SpaceSendRequest, SpaceStatus, models};
use theodore_ports::{NewAction, SyncActionCode};

use crate::core::Core;
use crate::error::AppResult;

/// What a blank space is called everywhere.
pub(crate) const BLANK_TITLE: &str = "New space";

/// The neutral name, and so the branch, until the real one arrives.
pub(crate) fn blank_name(id: &str) -> String {
    format!("new-space-{}", &id[..id.len().min(6)])
}

/// A blank space starting: what to name it from, and how to take it back.
pub(crate) struct BlankStart {
    space: String,
    /// The first message's words; `None` for files alone.
    goal: Option<String>,
    title: Option<String>,
}

impl Core {
    /// Called before your message's turn starts, with the space's queue
    /// lock held so one message at a time counts as the first. `None`: not
    /// a blank space, or nothing it could start from (the send refuses
    /// that itself). A setup still running refuses here, before anything
    /// changes.
    pub(crate) async fn begin_blank(
        &self,
        req: &SpaceSendRequest,
    ) -> AppResult<Option<BlankStart>> {
        let space = self.space_row(&req.space).await?;
        if !space.blank || space.status == SpaceStatus::Archived {
            return Ok(None);
        }
        if space.status != SpaceStatus::Running {
            self.check_setup_done(&space)?;
        }
        let text = req.text.trim();
        let (patch, goal) = if text.is_empty() {
            let files = self.resolve_attachments(req.attachments.as_deref()).await?;
            let Some(first) = files.first() else {
                return Ok(None);
            };
            (serde_json::json!({ "title": first.name }), None)
        } else {
            (
                serde_json::json!({ "goal": text, "title": null, "blank": false }),
                Some(text.to_string()),
            )
        };
        self.patch_blank(&space.id, patch).await?;
        Ok(Some(BlankStart {
            space: space.id,
            goal,
            title: space.title,
        }))
    }

    /// The turn didn't start: back to blank, so the text isn't lost as a
    /// goal and the next try names the space.
    pub(crate) async fn undo_begin_blank(&self, start: BlankStart) {
        let patch = serde_json::json!({ "goal": "", "title": start.title, "blank": true });
        if let Err(e) = self.patch_blank(&start.space, patch).await {
            tracing::warn!(space = %start.space, error = %e, "couldn't undo a blank start");
        }
    }

    /// The first words name the space: its goal, name and branch, as
    /// `create_space` would have named them. Files alone have nothing to
    /// name from.
    pub(crate) async fn name_started_blank(&self, start: BlankStart) {
        let Some(goal) = start.goal else { return };
        let Ok(space) = self.space_row(&start.space).await else {
            return;
        };
        let Ok(project) = self.space_project(&space).await else {
            return;
        };
        self.spawn_naming(
            &project,
            &space.id,
            goal,
            PathBuf::from(&space.worktree),
            false,
            false,
        )
        .await;
    }

    async fn patch_blank(&self, space: &str, patch: serde_json::Value) -> AppResult<()> {
        self.apply(vec![NewAction {
            model: models::SPACE.into(),
            model_id: space.to_string(),
            action: SyncActionCode::C,
            data: Some(patch),
        }])
        .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_blank_name_comes_from_the_id() {
        assert_eq!(blank_name("a1b2c3d4e5f6"), "new-space-a1b2c3");
    }
}
