//! A thumbs up or down on an agent's reply: kept on the reply, and sent as
//! `message_voted` (docs/telemetry.md "Product events") with what makes it
//! actionable — how the reply came about, never what it said.
//!
//! ```text
//! press ─▶ set_message_vote ─┬─ same as stored ─▶ nothing
//!                            └─ changed ─▶ row patched ─▶ sync ─▶ the thumbs
//!                                          └─▶ message_voted
//! ```

use theodore_contract::{ChatMessage, MessageVote, SetMessageVoteRequest, models};
use theodore_domain::Author;
use theodore_ports::{CHAT_RUN_PREFIX, NewAction, SyncActionCode};
use theodore_telemetry::ProductEvent;
use theodore_telemetry::product::TurnFacts;

use crate::core::Core;
use crate::error::{AppError, AppResult};
use crate::usecases::telemetry::{tool_calls, wire_str};

impl Core {
    /// Sets or (`vote: None`) takes back the vote on a reply.
    pub async fn set_message_vote(&self, req: SetMessageVoteRequest) -> AppResult<()> {
        let row = self
            .get_row(models::CHAT_MESSAGE, &req.message)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("message {}", req.message)))?;
        let message: ChatMessage =
            serde_json::from_value(row).map_err(|e| AppError::Invalid(e.to_string()))?;
        let Author::Agent(agent) = message.author else {
            return Err(AppError::Invalid(
                "only an agent's reply takes a vote".into(),
            ));
        };
        if message.vote == req.vote {
            return Ok(());
        }
        self.apply(vec![NewAction {
            model: models::CHAT_MESSAGE.into(),
            model_id: req.message.clone(),
            action: SyncActionCode::C,
            data: Some(serde_json::json!({ "vote": req.vote })),
        }])
        .await?;
        let vote = match req.vote {
            Some(MessageVote::Up) => "up",
            Some(MessageVote::Down) => "down",
            None => "cleared",
        };
        tracing::info!(message_id = %req.message, vote, "reply voted");
        let ms = self.reply_ms(&message).await;
        theodore_telemetry::product(ProductEvent::MessageVoted {
            vote: vote.to_string(),
            surface: surface_of(&message).to_string(),
            mode: message
                .mode
                .as_ref()
                .map_or_else(|| "none".to_string(), wire_str),
            turn: TurnFacts::new(
                agent.as_str(),
                (message.model.as_deref(), message.model_resolved),
                message.effort.as_deref(),
                outcome_of(&message),
                ms,
                (
                    tool_calls(&message.activity),
                    message.changed_files.len() as u32,
                ),
            ),
        });
        Ok(())
    }

    /// How long the reply took. An AI panel reply doesn't record it: the
    /// time since its question, which names the run.
    async fn reply_ms(&self, reply: &ChatMessage) -> Option<u64> {
        if reply.duration_ms.is_some() {
            return reply.duration_ms;
        }
        let question = reply.run.as_deref()?.strip_prefix(CHAT_RUN_PREFIX)?;
        let row = self
            .get_row(models::CHAT_MESSAGE, question)
            .await
            .ok()
            .flatten()?;
        let asked = serde_json::from_value::<ChatMessage>(row).ok()?.at;
        u64::try_from(reply.at - asked).ok()
    }
}

fn surface_of(message: &ChatMessage) -> &'static str {
    if message.pr.0.starts_with("space:") {
        "space"
    } else {
        "ai_panel"
    }
}

fn outcome_of(message: &ChatMessage) -> &'static str {
    match message.failed.as_deref() {
        None => "ok",
        Some("stopped" | "cancelled") => "stopped",
        Some(_) => "failed",
    }
}
