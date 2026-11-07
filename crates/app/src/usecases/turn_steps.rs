//! What an agent did in a space turn, in the order it did it: the reply's
//! `activity`. The reply itself stays the reply, so its text isn't told
//! twice:
//!
//! ```text
//! events  Text A ─ Tool ─ Thinking ─ Tool ─ Text B ─ Done "B"
//! steps   Text A ─ Tool ─ Thinking ─ Tool ─ Text B
//! stored  Text A ─ Tool ─ Thinking ─ Tool             reply "B"
//! ```
//!
//! A run with no final text (stopped, failed, a CLI that only sends `Text`)
//! has all its text in the reply: only its tools and thinking stay.

use theodore_contract::TurnStep;
use theodore_ports::AgentEvent;

use crate::usecases::agents::{tool_label, tool_target};

const STEPS_MAX: usize = 500;
const TEXT_MAX: usize = 4000;
pub(crate) const THINKING_MAX: usize = 1000;

/// One run's steps so far. Text stays whole until `finish`: what the reply
/// repeats is told by comparing it uncut.
#[derive(Default)]
pub(crate) struct TurnSteps {
    /// A tool call's step carries its id, for its result to find.
    steps: Vec<(Option<String>, TurnStep)>,
}

impl TurnSteps {
    pub(crate) fn record(&mut self, event: &AgentEvent) {
        match event {
            AgentEvent::Text { text } if !text.trim().is_empty() => {
                self.push(None, TurnStep::Text { text: text.clone() });
            }
            AgentEvent::Thinking { text } if !text.trim().is_empty() => {
                self.push(None, TurnStep::Thinking { text: text.clone() });
            }
            AgentEvent::ToolCall { id, name, input } => self.push(
                Some(id.clone()),
                TurnStep::Tool {
                    name: tool_label(name).to_string(),
                    target: tool_target(input),
                    ok: None,
                },
            ),
            AgentEvent::ToolResult { id, ok: result, .. } => {
                let call = self
                    .steps
                    .iter_mut()
                    .rev()
                    .find_map(|(of, step)| match step {
                        TurnStep::Tool { ok, .. } if of.as_ref() == Some(id) => Some(ok),
                        _ => None,
                    });
                if let Some(ok) = call {
                    *ok = Some(*result);
                }
            }
            _ => {}
        }
    }

    /// The newest steps count most: the oldest gives way.
    fn push(&mut self, id: Option<String>, step: TurnStep) {
        if self.steps.len() == STEPS_MAX {
            self.steps.remove(0);
        }
        self.steps.push((id, step));
    }

    /// The steps to store with a reply. `reply`: the text it ended on, whose
    /// blocks leave the steps; `None`: it is all the text blocks joined.
    pub(crate) fn finish(self, reply: Option<&str>) -> Vec<TurnStep> {
        let mut steps: Vec<TurnStep> = self.steps.into_iter().map(|(_, s)| s).collect();
        match reply {
            None => steps.retain(|s| !matches!(s, TurnStep::Text { .. })),
            Some(reply) => drop_told(&mut steps, reply),
        }
        for step in &mut steps {
            match step {
                TurnStep::Text { text } => *text = capped(text.trim(), TEXT_MAX),
                TurnStep::Thinking { text } => *text = capped(text.trim(), THINKING_MAX),
                TurnStep::Tool { .. } => {}
            }
        }
        steps
    }
}

/// Drops the last text blocks `reply` ends on, walking back through it: it
/// may join several results with blank lines. An earlier block that only
/// starts like the reply stays.
fn drop_told(steps: &mut Vec<TurnStep>, reply: &str) {
    let mut rest = reply.trim();
    let mut i = steps.len();
    while i > 0 && !rest.is_empty() {
        i -= 1;
        let TurnStep::Text { text } = &steps[i] else {
            continue;
        };
        let Some(at) = rest.rfind(text.trim()) else {
            break;
        };
        rest = rest[..at].trim_end();
        steps.remove(i);
    }
}

pub(crate) fn capped(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let kept: String = text.chars().take(max - 1).collect();
    format!("{kept}…")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(t: &str) -> AgentEvent {
        AgentEvent::Text { text: t.into() }
    }

    fn step(t: &str) -> TurnStep {
        TurnStep::Text { text: t.into() }
    }

    fn call(id: &str) -> AgentEvent {
        AgentEvent::ToolCall {
            id: id.into(),
            name: "Bash".into(),
            input: serde_json::json!({ "command": id }),
        }
    }

    fn recorded(events: &[AgentEvent]) -> TurnSteps {
        let mut steps = TurnSteps::default();
        for e in events {
            steps.record(e);
        }
        steps
    }

    #[test]
    fn a_reply_joining_results_drops_each_block_it_repeats() {
        let steps = recorded(&[text("A"), call("t"), text("B"), text("C")]);
        let kept = steps.finish(Some("B\n\nC"));
        assert_eq!(kept.len(), 2);
        assert_eq!(kept[0], step("A"));
    }

    #[test]
    fn an_earlier_block_that_only_starts_like_the_reply_stays() {
        let steps = recorded(&[text("Reading"), call("t"), text("Reading done.")]);
        let kept = steps.finish(Some("Reading done."));
        assert_eq!(kept.len(), 2);
        assert_eq!(kept[0], step("Reading"));
    }

    #[test]
    fn the_reply_found_past_a_later_tool_still_leaves_the_steps() {
        let steps = recorded(&[text("B"), call("t")]);
        let kept = steps.finish(Some("B"));
        assert!(matches!(kept.as_slice(), [TurnStep::Tool { .. }]));
    }

    #[test]
    fn steps_stay_bounded_and_small_and_results_still_find_their_call() {
        let mut events: Vec<AgentEvent> = (0..STEPS_MAX + 10)
            .map(|i| call(&format!("t{i}")))
            .collect();
        events.push(AgentEvent::ToolResult {
            id: format!("t{}", STEPS_MAX + 9),
            ok: false,
            output: String::new(),
        });
        // Long past the bound: nothing to set, nothing panics.
        events.push(AgentEvent::ToolResult {
            id: "t0".into(),
            ok: true,
            output: String::new(),
        });
        let kept = recorded(&events).finish(Some(""));
        assert_eq!(kept.len(), STEPS_MAX);
        assert!(matches!(
            kept.last(),
            Some(TurnStep::Tool {
                ok: Some(false),
                ..
            })
        ));

        let long = "x".repeat(TEXT_MAX * 2);
        let kept = recorded(&[text(&long)]).finish(Some("the reply"));
        let [TurnStep::Text { text }] = kept.as_slice() else {
            panic!("{kept:?}");
        };
        assert_eq!(text.chars().count(), TEXT_MAX);
        assert!(text.ends_with('…'));
    }

    #[test]
    fn a_long_block_the_reply_repeats_is_compared_uncut() {
        let long = "x".repeat(TEXT_MAX * 2);
        let kept = recorded(&[text(&long)]).finish(Some(&long));
        assert!(kept.is_empty());
    }
}
