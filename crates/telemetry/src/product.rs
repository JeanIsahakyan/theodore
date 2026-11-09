//! Product events (docs/telemetry.md "Events"): typed, with fixed field
//! names, emitted as `tracing` records tagged `kind="product"` on target
//! `theodore::product`. No code, paths, titles or comment text: every
//! field is a count, a duration, a flag or a value from a fixed set.

use serde::Serialize;

pub const TARGET: &str = "theodore::product";

/// What a voted-on or finished agent run was, for `message_voted`,
/// `space_turn` and `chat_answered`. Made through [`TurnFacts::new`], which
/// reduces free text to labels.
#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct TurnFacts {
    pub agent: String,
    /// [`model_label`].
    pub model: String,
    /// [`effort_label`].
    pub effort: String,
    /// `ok`, `failed`, `stopped`.
    pub outcome: String,
    /// [`duration_bucket`].
    pub duration: String,
    pub tools: u32,
    pub files: u32,
}

impl TurnFacts {
    pub fn new(
        agent: &str,
        (model, resolved): (Option<&str>, bool),
        effort: Option<&str>,
        outcome: &str,
        ms: Option<u64>,
        (tools, files): (u32, u32),
    ) -> Self {
        Self {
            agent: agent.to_string(),
            model: model_label(model, resolved),
            effort: effort_label(effort),
            outcome: outcome.to_string(),
            duration: duration_bucket(ms).to_string(),
            tools,
            files,
        }
    }
}

/// The families of model names the agent CLIs take. A name outside them is
/// someone's own deployment, and can say what it is for.
const MODEL_FAMILIES: &[&str] = &[
    "claude", "sonnet", "opus", "haiku", "fable", "gpt", "codex", "gemini", "o1", "o3", "o4",
];

/// A model name fit to send: one of the known families, else `custom`.
/// `default`: no model was asked for, so the CLI picked; `unknown`: a reply
/// from before the model was recorded.
pub fn model_label(model: Option<&str>, resolved: bool) -> String {
    let Some(name) = model.map(str::trim).filter(|m| !m.is_empty()) else {
        return if resolved { "default" } else { "unknown" }.to_string();
    };
    let shape = name.len() <= 48
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-._[]".contains(c));
    let lower = name.to_ascii_lowercase();
    if shape && MODEL_FAMILIES.iter().any(|f| lower.starts_with(f)) {
        lower
    } else {
        "custom".to_string()
    }
}

const EFFORTS: &[&str] = &["minimal", "low", "medium", "high", "xhigh", "max"];

/// An effort level, `default` when none was set, `custom` if unrecognized.
pub fn effort_label(effort: Option<&str>) -> String {
    match effort.map(str::trim).filter(|e| !e.is_empty()) {
        None => "default".to_string(),
        Some(e) if EFFORTS.contains(&e) => e.to_string(),
        Some(_) => "custom".to_string(),
    }
}

/// How long a run took, in the buckets a breakdown wants.
pub fn duration_bucket(ms: Option<u64>) -> &'static str {
    match ms {
        None => "unknown",
        Some(ms) if ms < 10_000 => "under_10s",
        Some(ms) if ms < 60_000 => "10s_1m",
        Some(ms) if ms < 300_000 => "1m_5m",
        Some(ms) if ms < 900_000 => "5m_15m",
        Some(_) => "over_15m",
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum ProductEvent {
    AppStarted {
        version: String,
        channel: String,
    },
    SignedIn,
    /// `account`, `telemetry`, `github`, `agents`, `projects`, `done`.
    OnboardingStep {
        step: String,
    },
    /// `github`, `gitlab`, `bitbucket`, `local`.
    PrOpened {
        host: String,
    },
    GroupingDone {
        ms: u64,
        /// The agent's first answer was valid (no repair round).
        valid_first_try: bool,
        groups: u32,
        hunks: u32,
        agent: String,
        /// How many agent calls the diff was split into.
        chunks: u32,
    },
    GroupingFailed {
        /// An error code (`grouping.invalid_output`, `agent.crashed`, …).
        code: String,
    },
    SkillRun {
        /// A built-in skill's id, or `custom`.
        skill: String,
        agents: u32,
        findings: u32,
        ms: u64,
        /// `ok`, `failed`, `stopped`.
        outcome: String,
    },
    /// `pr`, `group`, `hunk`.
    ChatAsked {
        scope: String,
    },
    TaskDelegated {
        agent: String,
    },
    TaskDecided {
        accepted: bool,
    },
    ReviewSubmitted {
        comments: u32,
        /// `approve`, `request_changes`, `comment` (not `event`: that names
        /// the event itself).
        review_event: String,
    },
    /// `merge`, `squash`, `rebase`.
    Merge {
        method: String,
    },
    SpaceCreated {
        mode: String,
        /// `blank`, `issue`, `branch`, `pr`.
        from: String,
    },
    SpaceTurn {
        ms: u64,
        mode: String,
        ok: bool,
        #[serde(flatten)]
        turn: TurnFacts,
    },
    /// An AI panel question got its answer, or didn't.
    ChatAnswered {
        #[serde(flatten)]
        turn: TurnFacts,
    },
    /// A reply's thumbs: `up`, `down`, `cleared`.
    MessageVoted {
        vote: String,
        /// `space`, `ai_panel`.
        surface: String,
        /// The space turn's mode; `none` in the AI panel.
        mode: String,
        #[serde(flatten)]
        turn: TurnFacts,
    },
    /// Stepping in on an agent: `stop`, `send_now`, `plan_approved`,
    /// `plan_revised`, `undo`, `back_to_here`.
    SpaceAction {
        action: String,
    },
    /// Queued messages now wait for you: `stopped`, `failed`,
    /// `checkpoint_skipped`, `start_failed`, `restart`.
    QueueHeld {
        reason: String,
        messages: u32,
    },
    /// The report window opened: `app`, `chat`, `agent`.
    ReportOpened {
        from: String,
    },
    /// Counted in the UI and sent every few minutes, not per use.
    UiCounts {
        tool_rows: u32,
        file_hovers: u32,
    },
    /// `open_pr`, `open_draft_pr`, `push`, `merge_locally`, `keep_branch`.
    SpaceShipped {
        how: String,
    },
    /// The config layer: `global`, `repo`, `local`.
    ConfigSaved {
        r#where: String,
    },
    /// "Report a problem" went through: `issue`, `issue_with_logs`,
    /// `logs_only`. Never the title, the comment or the issue.
    ProblemReported {
        mode: String,
    },
    /// An update is on disk and waits for a restart. The running version
    /// is `app_version`, as on every event.
    UpdateInstalled {
        version: String,
    },
    /// An update check or download failed: `read_only` (the app runs from
    /// the disk image or a translocated copy), `network`, `signature`,
    /// `other`.
    UpdateFailed {
        reason: String,
    },
    /// The first-launch "Move to Applications?" answer: `moved`,
    /// `declined`, `failed`; `from` is `volume`, `translocated`, `folder`.
    MoveToApplications {
        choice: String,
        from: String,
    },
}

impl ProductEvent {
    pub fn name(&self) -> &'static str {
        match self {
            ProductEvent::AppStarted { .. } => "app_started",
            ProductEvent::SignedIn => "signed_in",
            ProductEvent::OnboardingStep { .. } => "onboarding_step",
            ProductEvent::PrOpened { .. } => "pr_opened",
            ProductEvent::GroupingDone { .. } => "grouping_done",
            ProductEvent::GroupingFailed { .. } => "grouping_failed",
            ProductEvent::SkillRun { .. } => "skill_run",
            ProductEvent::ChatAsked { .. } => "chat_asked",
            ProductEvent::TaskDelegated { .. } => "task_delegated",
            ProductEvent::TaskDecided { .. } => "task_decided",
            ProductEvent::ReviewSubmitted { .. } => "review_submitted",
            ProductEvent::Merge { .. } => "merge",
            ProductEvent::SpaceCreated { .. } => "space_created",
            ProductEvent::SpaceTurn { .. } => "space_turn",
            ProductEvent::ChatAnswered { .. } => "chat_answered",
            ProductEvent::MessageVoted { .. } => "message_voted",
            ProductEvent::SpaceAction { .. } => "space_action",
            ProductEvent::QueueHeld { .. } => "queue_held",
            ProductEvent::ReportOpened { .. } => "report_opened",
            ProductEvent::UiCounts { .. } => "ui_counts",
            ProductEvent::SpaceShipped { .. } => "space_shipped",
            ProductEvent::ConfigSaved { .. } => "config_saved",
            ProductEvent::ProblemReported { .. } => "problem_reported",
            ProductEvent::UpdateInstalled { .. } => "update_installed",
            ProductEvent::UpdateFailed { .. } => "update_failed",
            ProductEvent::MoveToApplications { .. } => "move_to_applications",
        }
    }

    /// The event's own fields (without `event`).
    pub fn props(&self) -> serde_json::Map<String, serde_json::Value> {
        let mut v = match serde_json::to_value(self) {
            Ok(serde_json::Value::Object(m)) => m,
            _ => serde_json::Map::new(),
        };
        v.remove("event");
        v
    }

    /// Emits the event as a `tracing` record (`kind="product"`).
    pub fn emit(&self) {
        let props = serde_json::Value::Object(self.props()).to_string();
        tracing::info!(
            target: TARGET,
            kind = "product",
            event = self.name(),
            props = %props,
            "{}",
            self.name()
        );
    }

    /// One sample of every event, for the catalog and its tests.
    pub fn samples() -> Vec<ProductEvent> {
        let s = String::new;
        vec![
            ProductEvent::AppStarted {
                version: s(),
                channel: s(),
            },
            ProductEvent::SignedIn,
            ProductEvent::OnboardingStep { step: s() },
            ProductEvent::PrOpened { host: s() },
            ProductEvent::GroupingDone {
                ms: 0,
                valid_first_try: false,
                groups: 0,
                hunks: 0,
                agent: s(),
                chunks: 0,
            },
            ProductEvent::GroupingFailed { code: s() },
            ProductEvent::SkillRun {
                skill: s(),
                agents: 0,
                findings: 0,
                ms: 0,
                outcome: s(),
            },
            ProductEvent::ChatAsked { scope: s() },
            ProductEvent::TaskDelegated { agent: s() },
            ProductEvent::TaskDecided { accepted: false },
            ProductEvent::ReviewSubmitted {
                comments: 0,
                review_event: s(),
            },
            ProductEvent::Merge { method: s() },
            ProductEvent::SpaceCreated {
                mode: s(),
                from: s(),
            },
            ProductEvent::SpaceTurn {
                ms: 0,
                mode: s(),
                ok: false,
                turn: TurnFacts::default(),
            },
            ProductEvent::ChatAnswered {
                turn: TurnFacts::default(),
            },
            ProductEvent::MessageVoted {
                vote: s(),
                surface: s(),
                mode: s(),
                turn: TurnFacts::default(),
            },
            ProductEvent::SpaceAction { action: s() },
            ProductEvent::QueueHeld {
                reason: s(),
                messages: 0,
            },
            ProductEvent::ReportOpened { from: s() },
            ProductEvent::UiCounts {
                tool_rows: 0,
                file_hovers: 0,
            },
            ProductEvent::SpaceShipped { how: s() },
            ProductEvent::ConfigSaved { r#where: s() },
            ProductEvent::ProblemReported { mode: s() },
            ProductEvent::UpdateInstalled { version: s() },
            ProductEvent::UpdateFailed { reason: s() },
            ProductEvent::MoveToApplications {
                choice: s(),
                from: s(),
            },
        ]
    }

    /// Every event and its field names ("What's collected").
    pub fn catalog() -> Vec<theodore_contract::TelemetryEventInfo> {
        Self::samples()
            .iter()
            .map(|e| theodore_contract::TelemetryEventInfo {
                name: e.name().to_string(),
                fields: {
                    let mut f: Vec<String> = e.props().keys().cloned().collect();
                    f.sort();
                    f
                },
            })
            .collect()
    }
}

/// Emits `event`. Shorthand for `event.emit()`.
pub fn product(event: ProductEvent) {
    event.emit();
}

/// What is never sent, one line each ("What's collected").
pub fn never_sent() -> Vec<String> {
    [
        "Code, diffs, file contents or file paths",
        "Pull request titles, descriptions, comments or chat text",
        "Your email, name or host login (signed in, only the account's opaque id)",
        "Repository names (hashed with a key unique to this install)",
        "Tokens, passwords or other credentials",
        "Debug logs (they stay in the local log file)",
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}

const ONBOARDING_STEPS: &[&str] = &[
    "account",
    "telemetry",
    "github",
    "agents",
    "projects",
    "done",
];

const REPORT_FROM: &[&str] = &["app", "chat", "agent"];

/// More than this in one flush is a bug, not a person.
const MAX_UI_COUNT: u32 = 100_000;

/// A UI-reported event, if its values are known; anything else is dropped.
pub fn from_ui(event: &theodore_contract::UiEvent) -> Option<ProductEvent> {
    use theodore_contract::UiEvent;
    match event {
        UiEvent::OnboardingStep { step } => ONBOARDING_STEPS
            .contains(&step.as_str())
            .then(|| ProductEvent::OnboardingStep { step: step.clone() }),
        UiEvent::PlanRevised => Some(ProductEvent::SpaceAction {
            action: "plan_revised".into(),
        }),
        UiEvent::ReportOpened { from } => REPORT_FROM
            .contains(&from.as_str())
            .then(|| ProductEvent::ReportOpened { from: from.clone() }),
        UiEvent::UiCounts {
            tool_rows,
            file_hovers,
        } => ((*tool_rows > 0 || *file_hovers > 0)
            && *tool_rows <= MAX_UI_COUNT
            && *file_hovers <= MAX_UI_COUNT)
            .then_some(ProductEvent::UiCounts {
                tool_rows: *tool_rows,
                file_hovers: *file_hovers,
            }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    /// The wire shape of every event. Changing a field name or adding an
    /// event changes this: update `tests/product_events.json` and
    /// docs/telemetry.md together (`UPDATE_SNAPSHOTS=1` rewrites the file).
    #[test]
    fn product_event_shapes_match_the_snapshot() {
        // Serialized straight from the enum: field order is declaration order.
        let got = serde_json::to_string_pretty(&ProductEvent::samples()).expect("json") + "\n";
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/product_events.json");
        if std::env::var_os("UPDATE_SNAPSHOTS").is_some() {
            std::fs::write(path, &got).expect("write snapshot");
        }
        let want = std::fs::read_to_string(path).expect("snapshot file");
        assert_eq!(got, want);
    }

    #[test]
    fn every_event_has_a_unique_name_matching_its_tag() {
        let mut names = std::collections::BTreeSet::new();
        for e in ProductEvent::samples() {
            let v = serde_json::to_value(&e).unwrap();
            assert_eq!(v["event"], e.name());
            assert!(names.insert(e.name()), "{} twice", e.name());
        }
        assert_eq!(names.len(), ProductEvent::catalog().len());
    }

    #[test]
    fn the_catalog_lists_field_names() {
        let c = ProductEvent::catalog();
        let g = c.iter().find(|e| e.name == "grouping_done").unwrap();
        assert_eq!(
            g.fields,
            [
                "agent",
                "chunks",
                "groups",
                "hunks",
                "ms",
                "valid_first_try"
            ]
        );
        let w = c.iter().find(|e| e.name == "config_saved").unwrap();
        assert_eq!(w.fields, ["where"]);
    }

    #[test]
    fn ui_events_accept_only_known_steps() {
        let step = |s: &str| theodore_contract::UiEvent::OnboardingStep { step: s.into() };
        assert_eq!(
            from_ui(&step("github")),
            Some(ProductEvent::OnboardingStep {
                step: "github".into()
            })
        );
        assert_eq!(from_ui(&step("acme/secret-repo")), None);
    }

    #[test]
    fn ui_events_drop_unknown_values_and_empty_counts() {
        use theodore_contract::UiEvent;
        let report = |f: &str| UiEvent::ReportOpened { from: f.into() };
        assert_eq!(
            from_ui(&report("chat")),
            Some(ProductEvent::ReportOpened {
                from: "chat".into()
            })
        );
        assert_eq!(from_ui(&report("acme/secret-repo")), None);
        let counts = |tool_rows, file_hovers| UiEvent::UiCounts {
            tool_rows,
            file_hovers,
        };
        assert_eq!(from_ui(&counts(0, 0)), None);
        assert_eq!(from_ui(&counts(MAX_UI_COUNT + 1, 0)), None);
        assert!(from_ui(&counts(3, 0)).is_some());
    }

    #[test]
    fn model_names_outside_the_known_families_stay_home() {
        assert_eq!(
            model_label(Some("claude-opus-5-5[1m]"), true),
            "claude-opus-5-5[1m]"
        );
        assert_eq!(model_label(Some("Sonnet"), true), "sonnet");
        assert_eq!(model_label(Some("gpt-5.1-codex"), true), "gpt-5.1-codex");
        assert_eq!(model_label(Some("o3-mini"), true), "o3-mini");
        assert_eq!(model_label(None, true), "default");
        assert_eq!(model_label(None, false), "unknown");
        for private in [
            "acme/secret-repo",
            "acme-internal-finetune",
            "claude acme secret",
            "/Users/me/model.bin",
            &format!("claude-{}", "x".repeat(60)),
        ] {
            assert_eq!(model_label(Some(private), true), "custom", "{private}");
        }
    }

    #[test]
    fn efforts_and_durations_are_labels() {
        assert_eq!(effort_label(Some("high")), "high");
        assert_eq!(effort_label(None), "default");
        assert_eq!(effort_label(Some("acme")), "custom");
        assert_eq!(duration_bucket(None), "unknown");
        assert_eq!(duration_bucket(Some(9_999)), "under_10s");
        assert_eq!(duration_bucket(Some(10_000)), "10s_1m");
        assert_eq!(duration_bucket(Some(299_999)), "1m_5m");
        assert_eq!(duration_bucket(Some(899_999)), "5m_15m");
        assert_eq!(duration_bucket(Some(900_000)), "over_15m");
    }

    /// The whole property set, so a new field has to be looked at here: no
    /// prompt, reply, path or name, and a private model name stays home.
    #[test]
    fn a_vote_carries_labels_and_counts_only() {
        let event = ProductEvent::MessageVoted {
            vote: "down".into(),
            surface: "space".into(),
            mode: "edit".into(),
            turn: TurnFacts::new(
                "claude",
                (Some("acme/secret-repo"), true),
                Some("high"),
                "ok",
                Some(42_000),
                (7, 3),
            ),
        };
        assert_eq!(
            serde_json::Value::Object(event.props()),
            serde_json::json!({
                "vote": "down",
                "surface": "space",
                "mode": "edit",
                "agent": "claude",
                "model": "custom",
                "effort": "high",
                "outcome": "ok",
                "duration": "10s_1m",
                "tools": 7,
                "files": 3,
            })
        );
    }
}
