//! Findings from several agents merge into one (plan §4).

use std::collections::BTreeSet;

use crate::model::Finding;

const MERGE_LINE_TOLERANCE: i64 = 2;
const MERGE_TITLE_THRESHOLD: f32 = 0.6;

/// Same file + overlapping lines (±2) + similar title (Jaccard ≥ 0.6) → one
/// finding with the union of `agents`, keeping the higher severity. The
/// first matching existing finding wins; everything else about it (id,
/// anchor, title, body, state, fix) is kept as-is.
pub fn merge(existing: &[Finding], incoming: Finding) -> MergeOutcome {
    for f in existing {
        if f.anchor.path != incoming.anchor.path {
            continue;
        }
        let line_gap = (f.anchor.line as i64 - incoming.anchor.line as i64).abs();
        if line_gap > MERGE_LINE_TOLERANCE {
            continue;
        }
        if title_similarity(&f.title, &incoming.title) < MERGE_TITLE_THRESHOLD {
            continue;
        }
        let agents: BTreeSet<_> = f
            .agents
            .iter()
            .chain(incoming.agents.iter())
            .copied()
            .collect();
        let severity = f.severity.max(incoming.severity);
        return MergeOutcome::MergedInto(Finding {
            agents: agents.into_iter().collect(),
            severity,
            ..f.clone()
        });
    }
    MergeOutcome::New(incoming)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MergeOutcome {
    New(Finding),
    MergedInto(Finding),
}

/// Title similarity 0.0..=1.0: Jaccard overlap of lowercased alphanumeric
/// tokens (runs of non-alphanumeric characters are separators and don't
/// become tokens). Two titles with no tokens at all are defined as
/// identical (1.0).
pub fn title_similarity(a: &str, b: &str) -> f32 {
    fn tokens(s: &str) -> BTreeSet<String> {
        s.to_lowercase()
            .split(|c: char| !c.is_alphanumeric())
            .filter(|t| !t.is_empty())
            .map(|t| t.to_string())
            .collect()
    }
    let ta = tokens(a);
    let tb = tokens(b);
    if ta.is_empty() && tb.is_empty() {
        return 1.0;
    }
    let intersection = ta.intersection(&tb).count();
    let union = ta.union(&tb).count();
    intersection as f32 / union as f32
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{
        AgentId, Anchor, FindingId, FindingState, PrId, Severity, Sha, Side, SkillId,
    };

    fn finding(
        id: &str,
        path: &str,
        line: u32,
        title: &str,
        severity: Severity,
        agents: &[AgentId],
    ) -> Finding {
        Finding {
            id: FindingId::new(id),
            pr: PrId::new("pr"),
            skill: SkillId::new("skill"),
            agents: agents.to_vec(),
            anchor: Anchor {
                rev: Sha::new("head"),
                path: path.into(),
                side: Side::New,
                line,
                start_line: None,
                start_side: None,
            },
            severity,
            title: title.into(),
            body: String::new(),
            state: FindingState::Open,
            fix: None,
            outdated: false,
        }
    }

    #[test]
    fn similarity_identical_titles() {
        assert_eq!(
            title_similarity("SQL injection risk", "sql injection risk"),
            1.0
        );
    }

    #[test]
    fn similarity_disjoint_titles() {
        assert_eq!(title_similarity("abc", "xyz"), 0.0);
    }

    #[test]
    fn similarity_empty_titles_are_identical() {
        assert_eq!(title_similarity("", "   "), 1.0);
    }

    #[test]
    fn similarity_ignores_punctuation_and_case() {
        let a = title_similarity("N+1 query in UserService!", "n+1 query in userservice");
        assert_eq!(a, 1.0);
    }

    #[test]
    fn merge_same_line_similar_title_unions_agents_and_keeps_higher_severity() {
        let existing = vec![finding(
            "f1",
            "a.rs",
            10,
            "possible SQL injection",
            Severity::Warn,
            &[AgentId::Claude],
        )];
        let incoming = finding(
            "f2",
            "a.rs",
            11,
            "possible sql injection here",
            Severity::High,
            &[AgentId::Codex],
        );
        match merge(&existing, incoming) {
            MergeOutcome::MergedInto(f) => {
                assert_eq!(f.id, FindingId::new("f1"));
                assert_eq!(f.severity, Severity::High);
                assert_eq!(f.agents, vec![AgentId::Claude, AgentId::Codex]);
            }
            MergeOutcome::New(_) => panic!("expected a merge"),
        }
    }

    #[test]
    fn merge_duplicate_agent_does_not_repeat() {
        let existing = vec![finding(
            "f1",
            "a.rs",
            10,
            "possible SQL injection",
            Severity::Warn,
            &[AgentId::Claude],
        )];
        let incoming = finding(
            "f2",
            "a.rs",
            10,
            "possible SQL injection",
            Severity::Warn,
            &[AgentId::Claude],
        );
        match merge(&existing, incoming) {
            MergeOutcome::MergedInto(f) => assert_eq!(f.agents, vec![AgentId::Claude]),
            MergeOutcome::New(_) => panic!("expected a merge"),
        }
    }

    #[test]
    fn merge_different_path_stays_separate() {
        let existing = vec![finding(
            "f1",
            "a.rs",
            10,
            "possible SQL injection",
            Severity::Warn,
            &[AgentId::Claude],
        )];
        let incoming = finding(
            "f2",
            "b.rs",
            10,
            "possible SQL injection",
            Severity::Warn,
            &[AgentId::Codex],
        );
        assert!(matches!(merge(&existing, incoming), MergeOutcome::New(_)));
    }

    #[test]
    fn merge_line_too_far_stays_separate() {
        let existing = vec![finding(
            "f1",
            "a.rs",
            10,
            "possible SQL injection",
            Severity::Warn,
            &[AgentId::Claude],
        )];
        let incoming = finding(
            "f2",
            "a.rs",
            13,
            "possible SQL injection",
            Severity::Warn,
            &[AgentId::Codex],
        );
        assert!(matches!(merge(&existing, incoming), MergeOutcome::New(_)));
    }

    #[test]
    fn merge_dissimilar_title_stays_separate() {
        let existing = vec![finding(
            "f1",
            "a.rs",
            10,
            "possible SQL injection",
            Severity::Warn,
            &[AgentId::Claude],
        )];
        let incoming = finding(
            "f2",
            "a.rs",
            10,
            "missing null check",
            Severity::Warn,
            &[AgentId::Codex],
        );
        assert!(matches!(merge(&existing, incoming), MergeOutcome::New(_)));
    }

    #[test]
    fn merge_against_empty_existing_is_new() {
        let incoming = finding(
            "f1",
            "a.rs",
            10,
            "anything",
            Severity::Info,
            &[AgentId::Claude],
        );
        assert!(matches!(merge(&[], incoming), MergeOutcome::New(_)));
    }
}
