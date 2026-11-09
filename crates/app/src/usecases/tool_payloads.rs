//! What each tool call of a space turn took and gave, whole: what a row shows
//! when it is opened. Stored apart from the turn's steps, so bootstrap and
//! every sync frame stay light, and read only when a row opens.
//!
//! ```text
//! ToolCall ──────────────▶ input
//! ToolDetail ────────────▶ held for the result it comes before
//! ToolResult ────────────▶ result (held detail merged in); output the CLI
//!                          saved to a file read now, while it exists
//! ToolDetail{end} ───────▶ ended; the output_file read now, while it exists
//! ToolResult right after ▶ dropped: it only repeats the end's summary
//! ToolResult any later ──▶ result: a slow foreground call's end comes first
//! SubagentHandback ──────▶ report, on its Agent call
//! Agent's own result ────▶ report, when it holds one
//! ```
//!
//! Every piece is cut to its bound and says how large it was; a space keeps at
//! most `SPACE_MAX`, the oldest calls going first.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Instant;

use serde_json::{Value, json};
use theodore_contract::{
    CappedText, SavedKept, SavedOutput, ToolEnd, ToolInput, ToolOutcome, ToolPayload,
};
use theodore_ports::{AgentEvent, PersistedOutput, TaskEnd, ToolCallKey, ToolResultDetail};

use crate::core::Core;
use crate::error::{AppError, AppResult};
use crate::usecases::agents::tool_label;
use crate::usecases::turn_steps::{handback, is_agent_report, launched_in_background, unframed};

const TEXT_MAX: usize = 256 * 1024;
const INPUT_MAX: usize = 256 * 1024;
/// Of a whole space; `tool_payloads_prune` drops the oldest calls past it.
const SPACE_MAX: u64 = 64 * 1024 * 1024;
const CUT: &str = "\n… cut …\n";

/// The file a background call's output is kept in: only ours to read then.
const OUTPUT_FILE: &str = ".output";

/// A file whose text goes into a part when it's written, while the file exists.
#[derive(Debug, PartialEq, Eq)]
enum PartFile {
    /// A background call's whole output.
    Ended(PathBuf),
    /// A command's output the CLI saved because it outgrew the stream.
    Saved(PathBuf),
}

struct Part {
    call: String,
    name: &'static str,
    value: Value,
    file: Option<PartFile>,
}

impl Part {
    fn new(call: &str, name: &'static str, value: Value) -> Self {
        Self {
            call: call.to_string(),
            name,
            value,
            file: None,
        }
    }

    /// The text of `file`, read now, into what this part stores. Left as it
    /// is when it can't be read.
    fn take_file(value: &mut Value, file: PartFile) {
        match file {
            PartFile::Ended(path) => {
                if let Some((output, _)) = read_tail(&path) {
                    value["output"] = json!(output);
                }
            }
            PartFile::Saved(path) => {
                if let Some((mut output, len)) = read_tail(&path) {
                    let kept = if output.original_bytes.is_some() {
                        SavedKept::End
                    } else {
                        SavedKept::Whole
                    };
                    // `saved` says it: one note, not two.
                    output.original_bytes = None;
                    value["stdout"] = json!(output);
                    value["saved"] = json!(SavedOutput { bytes: len, kept });
                }
            }
        }
    }
}

/// One run's payloads, as its events come.
pub(crate) struct ToolPayloads {
    run: String,
    space: String,
    /// A call's label and when it started, by its id.
    calls: HashMap<String, (String, Instant)>,
    /// Details waiting for their result.
    details: HashMap<String, ToolResultDetail>,
    /// Handback calls: their results are nobody's.
    hidden: HashSet<String>,
    /// Calls whose end just came as a `ToolDetail`: the one result right
    /// behind it repeats it (`task_report`). Any later result is the call's own.
    repeats: HashSet<String>,
    /// Subagents whose handback carried the whole report.
    reported: HashSet<String>,
}

impl ToolPayloads {
    pub(crate) fn new(run: &str, space: &str) -> Self {
        Self {
            run: run.to_string(),
            space: space.to_string(),
            calls: HashMap::new(),
            details: HashMap::new(),
            hidden: HashSet::new(),
            repeats: HashSet::new(),
            reported: HashSet::new(),
        }
    }

    /// Stores what `event` adds. A failure only costs that row its details.
    pub(crate) async fn record(&mut self, core: &Core, event: &AgentEvent) {
        for part in self.parts(None, event) {
            self.write(core, part).await;
        }
    }

    /// The run is over: the space's oldest calls give way to its budget.
    pub(crate) async fn finish(self, core: &Core) {
        let store = core.0.deps.store.clone();
        let space = self.space;
        let pruned =
            tokio::task::spawn_blocking(move || store.tool_payloads_prune(&space, SPACE_MAX)).await;
        if let Ok(Err(e)) = pruned {
            tracing::debug!(error = %e, "couldn't prune tool payloads");
        }
    }

    async fn write(&self, core: &Core, part: Part) {
        let store = core.0.deps.store.clone();
        let key = ToolCallKey {
            run: self.run.clone(),
            call: part.call,
            space: self.space.clone(),
        };
        let name = part.name;
        let mut value = part.value;
        let file = part.file;
        let written = tokio::task::spawn_blocking(move || {
            if let Some(file) = file {
                Part::take_file(&mut value, file);
            }
            store.tool_payload_put(&key, name, &value)
        })
        .await;
        if let Ok(Err(e)) = written {
            tracing::debug!(error = %e, "couldn't store a tool payload");
        }
    }

    /// Pure, apart from what it remembers of the run: what `event` stores.
    fn parts(&mut self, parent: Option<&str>, event: &AgentEvent) -> Vec<Part> {
        match event {
            AgentEvent::Nested { parent, event } => self.parts(Some(parent), event),
            AgentEvent::ToolCall { id, name, input } => self.call(parent, id, name, input),
            AgentEvent::ToolDetail { id, detail } => self.detail(id, detail),
            AgentEvent::ToolResult { id, ok, output } => self.result(id, *ok, output),
            _ => vec![],
        }
    }

    fn call(&mut self, parent: Option<&str>, id: &str, name: &str, input: &Value) -> Vec<Part> {
        if handback(name, input).is_some() {
            self.hidden.insert(id.to_string());
            let report = input.get("message").and_then(Value::as_str);
            return match (parent, report) {
                (Some(of), Some(report)) => {
                    self.reported.insert(of.to_string());
                    vec![Part::new(
                        of,
                        "report",
                        json!(capped_text(unframed(report))),
                    )]
                }
                _ => vec![],
            };
        }
        if id.is_empty() {
            return vec![];
        }
        self.calls.insert(
            id.to_string(),
            (tool_label(name).to_string(), Instant::now()),
        );
        vec![Part::new(id, "input", json!(stored_input(input)))]
    }

    fn detail(&mut self, id: &str, detail: &ToolResultDetail) -> Vec<Part> {
        if self.hidden.contains(id) || id.is_empty() {
            return vec![];
        }
        let Some(end) = &detail.end else {
            self.details.insert(id.to_string(), detail.clone());
            return vec![];
        };
        self.repeats.insert(id.to_string());
        let call = self.calls.get(id);
        let is_agent = call.is_some_and(|(label, _)| matches!(label.as_str(), "Agent" | "Task"));
        let ended = ToolEnd {
            status: end.status.clone(),
            summary: end.summary.clone(),
            output: None,
            duration_ms: end
                .duration_ms
                .or_else(|| call.map(|(_, at)| at.elapsed().as_millis() as u64)),
        };
        let mut parts = vec![Part {
            file: (!is_agent)
                .then(|| output_file(end).map(PartFile::Ended))
                .flatten(),
            ..Part::new(id, "ended", json!(ended))
        }];
        // A handback said it whole; the notification only sums it up.
        if is_agent
            && !self.reported.contains(id)
            && let Some(summary) = &end.summary
        {
            parts.push(Part::new(id, "report", json!(capped_text(summary))));
        }
        parts
    }

    fn result(&mut self, id: &str, ok: bool, output: &str) -> Vec<Part> {
        if self.hidden.contains(id) || id.is_empty() || self.repeats.remove(id) {
            return vec![];
        }
        let detail = self.details.remove(id).unwrap_or_default();
        let call = self.calls.get(id);
        let label = call.map(|(label, _)| label.as_str()).unwrap_or_default();
        let streams = detail.stdout.is_some() || detail.stderr.is_some();
        let outcome = ToolOutcome {
            ok,
            // The same text again: only kept where nothing splits it up.
            output: (!streams || !ok).then(|| capped_text(output)),
            stdout: detail.stdout.as_deref().map(capped_text),
            stderr: detail.stderr.as_deref().map(capped_text),
            exit_code: detail.exit_code,
            duration_ms: (!detail.background)
                .then(|| call.map(|(_, at)| at.elapsed().as_millis() as u64))
                .flatten(),
            interrupted: detail.interrupted,
            background: detail.background || launched_in_background(label, output),
            // What the stream carried, until the file says otherwise.
            saved: detail
                .persisted_output
                .as_ref()
                .and_then(|p| p.bytes)
                .map(|bytes| SavedOutput {
                    bytes,
                    kept: SavedKept::Preview,
                }),
            resolved_model: detail.resolved_model.clone(),
        };
        let mut parts = vec![Part {
            file: detail
                .persisted_output
                .as_ref()
                .and_then(saved_output_file)
                .map(PartFile::Saved),
            ..Part::new(id, "result", json!(outcome))
        }];
        if is_agent_report(label, output) {
            parts.push(Part::new(
                id,
                "report",
                json!(capped_text(unframed(output))),
            ));
        }
        parts
    }
}

/// A background call's output file, when its name says it is one.
fn output_file(end: &TaskEnd) -> Option<PathBuf> {
    end.output_file
        .as_ref()
        .filter(|f| f.ends_with(OUTPUT_FILE))
        .map(PathBuf::from)
}

/// The file the CLI said holds a command's whole output: an absolute path, the
/// only form the CLI gives.
fn saved_output_file(saved: &PersistedOutput) -> Option<PathBuf> {
    let path = PathBuf::from(&saved.path);
    path.is_absolute().then_some(path)
}

/// At most `TEXT_MAX` from the end of `path`, a regular file (never a link or
/// a pipe), with its whole length: what it ended on matters most.
fn read_tail(path: &Path) -> Option<(CappedText, u64)> {
    use std::io::{Read, Seek, SeekFrom};
    if !std::fs::symlink_metadata(path).ok()?.is_file() {
        return None;
    }
    let mut file = std::fs::File::open(path).ok()?;
    let meta = file.metadata().ok()?;
    if !meta.is_file() {
        return None;
    }
    let len = meta.len();
    let take = len.min(TEXT_MAX as u64);
    file.seek(SeekFrom::Start(len - take)).ok()?;
    let mut bytes = Vec::new();
    file.take(take).read_to_end(&mut bytes).ok()?;
    let text = CappedText {
        text: String::from_utf8_lossy(&bytes).into_owned(),
        original_bytes: (len > take).then_some(len),
    };
    Some((text, len))
}

/// The start and the end of a long text, the cut marked in it.
fn capped_text(text: &str) -> CappedText {
    if text.len() <= TEXT_MAX {
        return CappedText {
            text: text.to_string(),
            original_bytes: None,
        };
    }
    let head = char_floor(text, TEXT_MAX * 3 / 4);
    let tail = char_floor(text, text.len() - TEXT_MAX / 4);
    CappedText {
        text: format!("{}{CUT}{}", &text[..head], &text[tail..]),
        original_bytes: Some(text.len() as u64),
    }
}

fn char_floor(text: &str, mut at: usize) -> usize {
    while !text.is_char_boundary(at) {
        at -= 1;
    }
    at
}

/// The input as sent; over the bound, its longest strings are cut so the rest
/// stays readable. Still over it (no string to cut), its text whole.
fn stored_input(input: &Value) -> ToolInput {
    let original = input.to_string().len();
    if original <= INPUT_MAX {
        return ToolInput {
            value: input.clone(),
            original_bytes: None,
        };
    }
    let mut limit = INPUT_MAX;
    loop {
        let cut = cut_strings(input, limit);
        if cut.to_string().len() <= INPUT_MAX {
            return ToolInput {
                value: cut,
                original_bytes: Some(original as u64),
            };
        }
        if limit < 64 {
            return ToolInput {
                value: Value::String(capped_text(&input.to_string()).text),
                original_bytes: Some(original as u64),
            };
        }
        limit /= 2;
    }
}

fn cut_strings(value: &Value, limit: usize) -> Value {
    match value {
        Value::String(s) if s.len() > limit => {
            Value::String(format!("{}{CUT}", &s[..char_floor(s, limit)]))
        }
        Value::Array(items) => Value::Array(items.iter().map(|v| cut_strings(v, limit)).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), cut_strings(v, limit)))
                .collect(),
        ),
        other => other.clone(),
    }
}

impl Core {
    /// What's stored of one tool call of `run`, for its row when opened.
    pub async fn tool_payload(&self, run: String, call: String) -> AppResult<Option<ToolPayload>> {
        let store = self.0.deps.store.clone();
        let stored = tokio::task::spawn_blocking(move || store.tool_payload_get(&run, &call))
            .await
            .map_err(AppError::join)??;
        Ok(stored.and_then(|value| serde_json::from_value(value).ok()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payloads() -> ToolPayloads {
        ToolPayloads::new("r1", "s1")
    }

    fn call(p: &mut ToolPayloads, id: &str, name: &str, input: Value) -> Vec<Part> {
        p.parts(
            None,
            &AgentEvent::ToolCall {
                id: id.into(),
                name: name.into(),
                input,
            },
        )
    }

    fn result(p: &mut ToolPayloads, id: &str, ok: bool, output: &str) -> Vec<Part> {
        p.parts(
            None,
            &AgentEvent::ToolResult {
                id: id.into(),
                ok,
                output: output.into(),
            },
        )
    }

    fn detail(p: &mut ToolPayloads, id: &str, detail: ToolResultDetail) -> Vec<Part> {
        p.parts(
            None,
            &AgentEvent::ToolDetail {
                id: id.into(),
                detail,
            },
        )
    }

    fn outcome(parts: &[Part]) -> ToolOutcome {
        serde_json::from_value(parts[0].value.clone()).unwrap()
    }

    #[test]
    fn a_call_and_its_result_are_stored_whole() {
        let mut p = payloads();
        let parts = call(&mut p, "t1", "Bash", json!({"command": "ls -la\npwd"}));
        assert_eq!(parts[0].name, "input");
        assert_eq!(parts[0].value["value"]["command"], "ls -la\npwd");
        let got = outcome(&result(&mut p, "t1", true, "a\nb"));
        assert_eq!(got.output.unwrap().text, "a\nb");
        assert!(got.duration_ms.is_some());
    }

    /// Real shape (2.1.319): both streams, joined, in `stdout`.
    #[test]
    fn one_combined_stream_is_kept_as_stdout() {
        let mut p = payloads();
        call(&mut p, "t1", "Bash", json!({"command": "x"}));
        detail(
            &mut p,
            "t1",
            ToolResultDetail {
                stdout: Some("to-stdout\nto-stderr".into()),
                exit_code: Some(0),
                ..ToolResultDetail::default()
            },
        );
        let got = outcome(&result(&mut p, "t1", true, "to-stdout\nto-stderr"));
        assert_eq!(got.output, None);
        assert_eq!(got.stdout.unwrap().text, "to-stdout\nto-stderr");
        assert_eq!(got.stderr, None);
        assert_eq!(got.exit_code, Some(0));
    }

    #[test]
    fn two_real_streams_replace_the_text_that_joins_them() {
        let mut p = payloads();
        call(&mut p, "t1", "Bash", json!({"command": "x"}));
        detail(
            &mut p,
            "t1",
            ToolResultDetail {
                stdout: Some("out".into()),
                stderr: Some("err".into()),
                exit_code: Some(0),
                ..ToolResultDetail::default()
            },
        );
        let got = outcome(&result(&mut p, "t1", true, "out\nerr"));
        assert_eq!(got.output, None);
        assert_eq!(got.stdout.unwrap().text, "out");
        assert_eq!(got.stderr.unwrap().text, "err");
    }

    /// Real shape (2.1.319): a failure has no streams, only its text.
    #[test]
    fn a_failures_text_is_its_output_and_its_exit_code_is_read_from_it() {
        let mut p = payloads();
        call(&mut p, "t1", "Bash", json!({"command": "x"}));
        detail(
            &mut p,
            "t1",
            ToolResultDetail {
                exit_code: Some(1),
                ..ToolResultDetail::default()
            },
        );
        let text = "Exit code 1\nout\nerr\nls: nope: No such file or directory";
        let got = outcome(&result(&mut p, "t1", false, text));
        assert_eq!(got.output.unwrap().text, text);
        assert_eq!(got.exit_code, Some(1));
        assert!(!got.ok);
    }

    fn bash_with_saved_output(path: &str, bytes: Option<u64>) -> Vec<Part> {
        let mut p = payloads();
        call(&mut p, "t1", "Bash", json!({"command": "seq 1 200000"}));
        detail(
            &mut p,
            "t1",
            ToolResultDetail {
                stdout: Some("preview".into()),
                exit_code: Some(0),
                persisted_output: Some(PersistedOutput {
                    path: path.into(),
                    bytes,
                }),
                ..ToolResultDetail::default()
            },
        );
        result(&mut p, "t1", true, "preview")
    }

    /// Real shape (2.1.319), `seq 1 200000`: 30000 chars in the stream, the
    /// whole 1.3 MB in a file.
    #[test]
    fn saved_output_over_the_bound_keeps_its_end_and_says_how_long_it_was() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("t1.txt");
        let text = format!("first\n{}last", "x".repeat(TEXT_MAX));
        std::fs::write(&file, &text).unwrap();
        let mut parts = bash_with_saved_output(file.to_str().unwrap(), Some(text.len() as u64));
        let saved = parts[0].file.take().unwrap();
        assert_eq!(saved, PartFile::Saved(file.clone()));
        Part::take_file(&mut parts[0].value, saved);
        let got = outcome(&parts);
        let stdout = got.stdout.unwrap();
        assert!(stdout.text.ends_with("last"));
        assert!(!stdout.text.contains("first"));
        assert_eq!(stdout.original_bytes, None, "said once, by `saved`");
        assert_eq!(
            got.saved,
            Some(SavedOutput {
                bytes: text.len() as u64,
                kept: SavedKept::End,
            })
        );
    }

    #[test]
    fn saved_output_that_fits_is_read_whole() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("t1.txt");
        std::fs::write(&file, "whole output").unwrap();
        let mut parts = bash_with_saved_output(file.to_str().unwrap(), Some(12));
        let saved = parts[0].file.take().unwrap();
        Part::take_file(&mut parts[0].value, saved);
        let got = outcome(&parts);
        assert_eq!(got.stdout.unwrap().text, "whole output");
        assert_eq!(
            got.saved,
            Some(SavedOutput {
                bytes: 12,
                kept: SavedKept::Whole,
            })
        );
    }

    #[test]
    fn saved_output_that_cant_be_read_keeps_the_preview_and_the_size() {
        let dir = tempfile::tempdir().unwrap();
        let gone = dir.path().join("gone.txt");
        let mut parts = bash_with_saved_output(gone.to_str().unwrap(), Some(1_288_895));
        let saved = parts[0].file.take().unwrap();
        Part::take_file(&mut parts[0].value, saved);
        let got = outcome(&parts);
        assert_eq!(got.stdout.unwrap().text, "preview");
        assert_eq!(
            got.saved,
            Some(SavedOutput {
                bytes: 1_288_895,
                kept: SavedKept::Preview,
            })
        );
    }

    #[test]
    fn only_an_absolute_path_the_cli_named_is_read_as_saved_output() {
        assert!(
            bash_with_saved_output("relative/t1.txt", Some(1))[0]
                .file
                .is_none()
        );
    }

    #[cfg(unix)]
    #[test]
    fn neither_a_link_nor_a_pipe_is_read() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("real.txt");
        std::fs::write(&target, "secret").unwrap();
        let link = dir.path().join("link.txt");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert_eq!(read_tail(&link), None);
        assert_eq!(read_tail(dir.path()), None);
        assert_eq!(read_tail(&target).unwrap().0.text, "secret");
    }

    #[test]
    fn a_subagents_model_is_kept_from_its_result() {
        let mut p = payloads();
        call(&mut p, "a", "Agent", json!({"prompt": "do it"}));
        detail(
            &mut p,
            "a",
            ToolResultDetail {
                resolved_model: Some("claude-haiku-5-5".into()),
                ..ToolResultDetail::default()
            },
        );
        let got = outcome(&result(&mut p, "a", true, "All done."));
        assert_eq!(got.resolved_model.as_deref(), Some("claude-haiku-5-5"));
    }

    #[test]
    fn long_text_keeps_both_ends_and_says_how_long_it_was() {
        let text = format!("start{}end", "é".repeat(TEXT_MAX));
        let cut = capped_text(&text);
        assert_eq!(cut.original_bytes, Some(text.len() as u64));
        assert!(cut.text.starts_with("start"));
        assert!(cut.text.ends_with("end"));
        assert!(cut.text.contains(CUT));
        // A multi-byte character may hold the tail's start back by a byte or so.
        assert!(cut.text.len() <= TEXT_MAX + CUT.len() + 3);
    }

    #[test]
    fn short_text_is_left_alone() {
        let cut = capped_text("hello");
        assert_eq!(cut.text, "hello");
        assert_eq!(cut.original_bytes, None);
    }

    #[test]
    fn a_huge_input_keeps_its_shape_and_its_other_fields() {
        let input = json!({
            "file_path": "a.rs",
            "content": "x".repeat(INPUT_MAX * 2),
        });
        let stored = stored_input(&input);
        assert!(stored.original_bytes.unwrap() > INPUT_MAX as u64);
        assert_eq!(stored.value["file_path"], "a.rs");
        let content = stored.value["content"].as_str().unwrap();
        assert!(content.ends_with(CUT));
        assert!(stored.value.to_string().len() <= INPUT_MAX);
    }

    #[test]
    fn an_input_with_no_string_to_cut_is_stored_as_its_text() {
        let numbers: Vec<u32> = vec![1234567; INPUT_MAX];
        let stored = stored_input(&json!({ "n": numbers }));
        assert!(stored.value.is_string());
        assert!(stored.original_bytes.is_some());
    }

    #[test]
    fn a_handback_is_its_agents_report_whole() {
        let mut p = payloads();
        call(&mut p, "agent", "Agent", json!({"prompt": "do it"}));
        let event = AgentEvent::Nested {
            parent: "agent".into(),
            event: Box::new(AgentEvent::ToolCall {
                id: "back".into(),
                name: "SubagentHandback".into(),
                input: json!({"message": format!("line one\n{}", "more ".repeat(1000))}),
            }),
        };
        let parts = p.parts(None, &event);
        assert_eq!(parts[0].call, "agent");
        assert_eq!(parts[0].name, "report");
        let report: CappedText = serde_json::from_value(parts[0].value.clone()).unwrap();
        assert!(report.text.starts_with("line one\nmore more"));
        assert_eq!(report.original_bytes, None);
        // Its result is nobody's.
        assert!(result(&mut p, "back", true, "delivered").is_empty());
    }

    #[test]
    fn an_agents_own_result_is_its_report_unless_it_only_points_at_one() {
        let mut p = payloads();
        call(&mut p, "a", "Agent", json!({}));
        let parts = result(&mut p, "a", true, "All done.\n\nDetails here");
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[1].value["text"], "All done.\n\nDetails here");

        call(&mut p, "b", "Agent", json!({}));
        let pointer = "This agent's report was delivered to you as a message.\nagentId: b";
        assert_eq!(result(&mut p, "b", true, pointer).len(), 1);

        call(&mut p, "c", "Agent", json!({"run_in_background": true}));
        let started = "Async agent launched successfully. agentId: c";
        let parts = result(&mut p, "c", true, started);
        assert_eq!(parts.len(), 1);
        assert!(outcome(&parts).background);
    }

    #[test]
    fn a_background_call_keeps_its_start_and_its_end_apart() {
        let mut p = payloads();
        call(
            &mut p,
            "b",
            "Bash",
            json!({"command": "sleep 1", "run_in_background": true}),
        );
        detail(
            &mut p,
            "b",
            ToolResultDetail {
                background: true,
                ..ToolResultDetail::default()
            },
        );
        let start = outcome(&result(&mut p, "b", true, "running as b1"));
        assert!(start.background);
        assert_eq!(start.exit_code, None);
        assert_eq!(start.duration_ms, None);

        let end = detail(
            &mut p,
            "b",
            ToolResultDetail {
                end: Some(TaskEnd {
                    status: "completed".into(),
                    summary: Some("done, exit 0".into()),
                    output_file: Some("/tmp/tasks/b1.output".into()),
                    duration_ms: Some(1200),
                }),
                ..ToolResultDetail::default()
            },
        );
        assert_eq!(end.len(), 1);
        assert_eq!(end[0].name, "ended");
        assert_eq!(
            end[0].file,
            Some(PartFile::Ended("/tmp/tasks/b1.output".into()))
        );
        let stored: ToolEnd = serde_json::from_value(end[0].value.clone()).unwrap();
        assert_eq!(stored.status, "completed");
        assert_eq!(stored.duration_ms, Some(1200));
        // The repeat of that end doesn't overwrite the start.
        assert!(result(&mut p, "b", true, "done, exit 0").is_empty());
    }

    fn task_end(summary: &str) -> ToolResultDetail {
        ToolResultDetail {
            end: Some(TaskEnd {
                status: "completed".into(),
                summary: Some(summary.into()),
                output_file: None,
                duration_ms: Some(3000),
            }),
            ..ToolResultDetail::default()
        }
    }

    fn streams(stdout: &str) -> ToolResultDetail {
        ToolResultDetail {
            stdout: Some(stdout.into()),
            exit_code: Some(0),
            ..ToolResultDetail::default()
        }
    }

    /// A slow foreground command: the task's end arrives, then the command's
    /// real output. The end's repeat must not take the result's place.
    #[test]
    fn a_foreground_result_after_its_end_is_stored() {
        let mut p = payloads();
        call(
            &mut p,
            "t1",
            "Bash",
            json!({"command": "sleep 3; echo slept-3"}),
        );
        assert_eq!(detail(&mut p, "t1", task_end("Sleep"))[0].name, "ended");
        assert!(result(&mut p, "t1", true, "Sleep").is_empty(), "the repeat");

        detail(&mut p, "t1", streams("slept-3"));
        let parts = result(&mut p, "t1", true, "slept-3");
        assert_eq!(parts[0].name, "result");
        let got = outcome(&parts);
        assert_eq!(got.stdout.unwrap().text, "slept-3");
        assert_eq!(got.exit_code, Some(0));
        assert!(!got.background);
    }

    #[test]
    fn a_foreground_result_before_its_end_is_stored() {
        let mut p = payloads();
        call(
            &mut p,
            "t1",
            "Bash",
            json!({"command": "sleep 3; echo slept-3"}),
        );
        detail(&mut p, "t1", streams("slept-3"));
        let parts = result(&mut p, "t1", true, "slept-3");
        assert_eq!(outcome(&parts).stdout.unwrap().text, "slept-3");

        assert_eq!(detail(&mut p, "t1", task_end("Sleep"))[0].name, "ended");
        assert!(result(&mut p, "t1", true, "Sleep").is_empty(), "the repeat");
    }

    /// Whichever comes first, the launch stays a launch and the end's repeat
    /// never stands in for it.
    #[test]
    fn a_background_launch_after_its_end_is_still_the_start() {
        let mut p = payloads();
        call(
            &mut p,
            "b",
            "Bash",
            json!({"command": "sleep 1", "run_in_background": true}),
        );
        detail(&mut p, "b", task_end("done, exit 0"));
        assert!(result(&mut p, "b", true, "done, exit 0").is_empty());

        detail(
            &mut p,
            "b",
            ToolResultDetail {
                background: true,
                ..ToolResultDetail::default()
            },
        );
        let start = outcome(&result(&mut p, "b", true, "running as b1"));
        assert!(start.background);
        assert_eq!(start.exit_code, None);
    }

    #[test]
    fn a_background_subagents_end_is_its_report_and_no_file_is_read() {
        let mut p = payloads();
        call(&mut p, "a", "Agent", json!({"run_in_background": true}));
        let end = detail(
            &mut p,
            "a",
            ToolResultDetail {
                end: Some(TaskEnd {
                    status: "completed".into(),
                    summary: Some("pong".into()),
                    output_file: Some("/tmp/a.output".into()),
                    duration_ms: None,
                }),
                ..ToolResultDetail::default()
            },
        );
        assert_eq!(end[0].file, None);
        assert_eq!(end[1].name, "report");
        assert_eq!(end[1].value["text"], "pong");
    }

    #[test]
    fn only_an_output_file_is_read() {
        let end = |path: &str| TaskEnd {
            status: "completed".into(),
            summary: None,
            output_file: Some(path.into()),
            duration_ms: None,
        };
        assert!(output_file(&end("/tmp/b1.output")).is_some());
        assert!(output_file(&end("/etc/passwd")).is_none());
    }

    #[test]
    fn a_long_output_file_keeps_its_end_and_says_how_long_it_was() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("b1.output");
        let text = format!("first\n{}last", "x".repeat(TEXT_MAX));
        std::fs::write(&path, &text).unwrap();
        let (got, len) = read_tail(&path).unwrap();
        assert_eq!(len, text.len() as u64);
        assert_eq!(got.original_bytes, Some(text.len() as u64));
        assert!(got.text.ends_with("last"));
        assert!(!got.text.contains("first"));
    }

    #[test]
    fn a_call_with_no_id_stores_nothing() {
        let mut p = payloads();
        assert!(call(&mut p, "", "Bash", json!({})).is_empty());
        assert!(result(&mut p, "", true, "x").is_empty());
    }
}
