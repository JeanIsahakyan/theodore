//! The agent-facing JSON schema and its conversion to `theodore_domain::Grouping`.
//!
//! Kept intentionally looser than the domain type (missing fields default,
//! unknown kind strings fall back to `Normal`) because repair is cheaper
//! than rejecting an almost-right answer outright — `domain::grouping::validate`
//! is the real gate.

use serde::Deserialize;
use theodore_domain::{Group, GroupId, GroupKind, Grouping, HunkId, Sha};

#[derive(Debug, Clone, Deserialize)]
pub struct RawGroup {
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub why: String,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub risk: Option<String>,
    #[serde(default)]
    pub check: Vec<String>,
    #[serde(default)]
    pub hunks: Vec<String>,
    #[serde(default)]
    pub outliers: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct RawGrouping {
    #[serde(default)]
    pub groups: Vec<RawGroup>,
}

fn kind_from_str(s: Option<&str>) -> GroupKind {
    match s {
        Some("skim") => GroupKind::Skim,
        Some("hidden") => GroupKind::Hidden,
        _ => GroupKind::Normal,
    }
}

impl RawGroup {
    pub fn into_domain(self) -> Group {
        Group {
            id: GroupId::new(self.id),
            title: self.title,
            why: self.why,
            kind: kind_from_str(self.kind.as_deref()),
            risk: self.risk,
            check: self.check,
            hunks: self.hunks.into_iter().map(HunkId::new).collect(),
            outliers: self.outliers.into_iter().map(HunkId::new).collect(),
        }
    }
}

impl RawGrouping {
    pub fn into_domain(self, rev: Sha) -> Grouping {
        Grouping {
            rev,
            groups: self.groups.into_iter().map(RawGroup::into_domain).collect(),
        }
    }
}

/// Parse `text` (tolerating fences/prose via `extract_json`) into a `Grouping`
/// against `rev`. An empty `Grouping` (no groups) is returned, not an error,
/// when nothing in the text parses — the caller's validation pass turns that
/// into the "Other" fallback like any other invalid output.
pub fn parse_grouping(text: &str, rev: Sha) -> Grouping {
    let raw = crate::parse::extract_json(text)
        .and_then(|v| serde_json::from_value::<RawGrouping>(v).ok())
        .unwrap_or_default();
    raw.into_domain(rev)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_well_formed_grouping() {
        let text = r#"{
            "groups": [
                {"id": "g1", "title": "Schema", "why": "adds a table", "kind": "normal",
                 "check": ["migration is safe"], "hunks": ["h1", "h2"], "outliers": []}
            ]
        }"#;
        let g = parse_grouping(text, Sha::new("abc"));
        assert_eq!(g.groups.len(), 1);
        assert_eq!(g.groups[0].id, GroupId::new("g1"));
        assert_eq!(g.groups[0].kind, GroupKind::Normal);
        assert_eq!(
            g.groups[0].hunks,
            vec![HunkId::new("h1"), HunkId::new("h2")]
        );
    }

    #[test]
    fn garbage_text_yields_empty_grouping() {
        let g = parse_grouping("I can't do that.", Sha::new("abc"));
        assert!(g.groups.is_empty());
    }

    #[test]
    fn unknown_kind_falls_back_to_normal() {
        let text = r#"{"groups": [{"id": "g1", "title": "t", "why": "w", "kind": "mystery", "hunks": ["h1"]}]}"#;
        let g = parse_grouping(text, Sha::new("abc"));
        assert_eq!(g.groups[0].kind, GroupKind::Normal);
    }
}
