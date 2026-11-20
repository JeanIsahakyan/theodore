//! A space's notes (docs/spaces.md "Sub-spaces, and asking other spaces"):
//! who asked it what, shown in its timeline for its owner.
//!
//! ```text
//! space_ask / ask_space ─▶ fork or fresh read ─▶ answer | failed
//!                                                  └─▶ space_note row, pr = space:<B>
//! B's turns, space_history, space_read, handoff,  ─▶ chat_message only
//! fleet mirror, shipping, reports                     (never space_note)
//! ```
//!
//! A model of its own rather than a chat row: nothing that builds a prompt
//! or a transcript queries it, so it can't leak into one by accident.

use theodore_contract::{AskedBy, SpaceAskNote, SpaceNote, models};
use theodore_domain::AgentId;
use theodore_ports::{LocalSpaceAsk, NewAction, SpaceToolError, SyncActionCode};

use crate::core::Core;
use crate::usecases::space_children::AskFrom;
use crate::usecases::spaces::space_chat_key;

/// The agent, model and way (`fork` / `fresh`) an ask last tried.
pub(crate) type AskTry = (AgentId, Option<String>, &'static str);

/// Kept of a question and its answer; the rest is cut.
const QUESTION_CHARS: usize = 2_000;
const ANSWER_CHARS: usize = 20_000;

fn capped(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        Some((i, _)) => format!("{}…", &s[..i]),
        None => s.to_string(),
    }
}

impl Core {
    /// Records that `row` was asked `question` by `from`, and how it went.
    /// Best-effort: a note that can't be written never fails the ask.
    pub(crate) async fn note_ask(
        &self,
        row: &theodore_contract::Space,
        from: &AskFrom,
        question: &str,
        asked: &Result<LocalSpaceAsk, SpaceToolError>,
        tried: Option<AskTry>,
    ) {
        let (agent, model, how) = match tried {
            Some((a, m, h)) => (Some(a), m, Some(h.to_string())),
            None => (None, None, None),
        };
        let ask = match asked {
            Ok(a) => SpaceAskNote {
                from: asked_by(from),
                question: capped(question, QUESTION_CHARS),
                answer: Some(capped(&a.answer, ANSWER_CHARS)),
                failed: None,
                agent,
                model: a.model.clone(),
                how: Some(a.how.to_string()),
            },
            Err(e) => SpaceAskNote {
                from: asked_by(from),
                question: capped(question, QUESTION_CHARS),
                answer: None,
                failed: Some(failure(e)),
                agent,
                model,
                how,
            },
        };
        let note = SpaceNote {
            id: uuid::Uuid::new_v4().to_string(),
            pr: space_chat_key(&row.id),
            at: self.0.deps.clock.now(),
            ask,
        };
        let Ok(data) = serde_json::to_value(&note) else {
            return;
        };
        if let Err(e) = self
            .apply(vec![NewAction {
                model: models::SPACE_NOTE.into(),
                model_id: note.id,
                action: SyncActionCode::I,
                data: Some(data),
            }])
            .await
        {
            tracing::warn!(space = %row.id, error = %e, "couldn't note a space_ask");
        }
    }
}

fn asked_by(from: &AskFrom) -> AskedBy {
    match from {
        AskFrom::Space(f) => AskedBy::Space {
            space: f.space.clone(),
            title: f.title.clone(),
        },
        AskFrom::Device(name) => AskedBy::Device { name: name.clone() },
    }
}

/// The refusal's words, without its `sub_spaces.<code>:` prefix.
fn failure(e: &SpaceToolError) -> String {
    let s = e.to_string();
    match s.split_once(": ") {
        Some((code, why)) if code.contains("sub_spaces.") => why.to_string(),
        _ => s,
    }
}
