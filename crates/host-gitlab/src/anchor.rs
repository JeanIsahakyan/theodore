//! Domain `Anchor` <-> GitLab diff note `position` (plan §6.3).
//!
//! A GitLab text position pins `old_line` (LEFT/old file) or `new_line`
//! (RIGHT/new file), plus the three shas of the diff it was made against
//! (`base_sha`, `start_sha`, `head_sha` - GitLab's `diff_refs`). A multi-line
//! comment adds `line_range{start,end}`, each a `line_code` of the form
//! `<sha1(path)>_<old_line>_<new_line>` plus a `type` (`"old"`/`"new"`).
//!
//! The domain's `Anchor` only carries one line number per endpoint of the
//! range (`line`/`side`, `start_line`/`start_side`), not the old/new pair a
//! real `line_code` needs for an unchanged context line. We fill the unknown
//! side with `0` (GitLab's own convention for "this side has no line here",
//! used for pure additions/deletions); comments anchored on an added or
//! removed line - the overwhelming majority - round-trip exactly, a context
//! line's `line_code` just isn't bit-for-bit what GitLab's own UI would mint.

use sha1::{Digest, Sha1};
use theodore_domain::{Anchor, Sha, Side};

/// `diff_refs` of the revision a position is made against.
#[derive(Debug, Clone)]
pub(crate) struct DiffRefs {
    pub base_sha: String,
    pub start_sha: String,
    pub head_sha: String,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub(crate) struct GitlabLinePoint {
    pub line_code: String,
    #[serde(rename = "type")]
    pub kind: Option<String>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub(crate) struct GitlabLineRange {
    pub start: GitlabLinePoint,
    pub end: GitlabLinePoint,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub(crate) struct GitlabPosition {
    pub base_sha: String,
    pub start_sha: String,
    pub head_sha: String,
    pub old_path: String,
    pub new_path: String,
    pub position_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_line: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_line: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_range: Option<GitlabLineRange>,
}

fn line_code(path: &str, side: Side, line: u32) -> String {
    let hash = hex::encode(Sha1::digest(path.as_bytes()));
    match side {
        Side::Old => format!("{hash}_{line}_0"),
        Side::New => format!("{hash}_0_{line}"),
    }
}

fn line_point(path: &str, side: Side, line: u32) -> GitlabLinePoint {
    GitlabLinePoint {
        line_code: line_code(path, side, line),
        kind: Some(side_to_type(side).to_string()),
    }
}

fn side_to_type(side: Side) -> &'static str {
    match side {
        Side::Old => "old",
        Side::New => "new",
    }
}

fn side_from_type(kind: Option<&str>) -> Side {
    match kind {
        Some("old") => Side::Old,
        _ => Side::New,
    }
}

pub(crate) fn to_position(anchor: &Anchor, refs: &DiffRefs) -> GitlabPosition {
    let (old_line, new_line) = match anchor.side {
        Side::Old => (Some(anchor.line), None),
        Side::New => (None, Some(anchor.line)),
    };
    let line_range = anchor.start_line.map(|start_line| GitlabLineRange {
        start: line_point(
            &anchor.path,
            anchor.start_side.unwrap_or(anchor.side),
            start_line,
        ),
        end: line_point(&anchor.path, anchor.side, anchor.line),
    });
    GitlabPosition {
        base_sha: refs.base_sha.clone(),
        start_sha: refs.start_sha.clone(),
        head_sha: refs.head_sha.clone(),
        old_path: anchor.path.clone(),
        new_path: anchor.path.clone(),
        position_type: "text".to_string(),
        old_line,
        new_line,
        line_range,
    }
}

/// Reconstructs the domain anchor from a note's `position`. `rev` is the
/// commit the caller already resolved (the position's own `head_sha`).
pub(crate) fn from_position(rev: Sha, pos: &GitlabPosition) -> Option<Anchor> {
    let (side, line, path) = match (pos.old_line, pos.new_line) {
        (_, Some(l)) => (Side::New, l, &pos.new_path),
        (Some(l), None) => (Side::Old, l, &pos.old_path),
        (None, None) => return None,
    };
    let (start_line, start_side) = match &pos.line_range {
        Some(lr) => (
            line_from_code(&lr.start.line_code),
            Some(side_from_type(lr.start.kind.as_deref())),
        ),
        None => (None, None),
    };
    Some(Anchor {
        rev,
        path: path.clone(),
        side,
        line,
        start_line,
        start_side,
    })
}

/// Pulls the trailing `<old>_<new>` pair out of a `line_code` minted by
/// [`line_code`] and picks the non-zero one (there is at most one for a line
/// we generated ourselves - see the module doc for the context-line caveat).
fn line_from_code(code: &str) -> Option<u32> {
    let mut parts = code.rsplit('_');
    let new_line: u32 = parts.next()?.parse().ok()?;
    let old_line: u32 = parts.next()?.parse().ok()?;
    match (old_line, new_line) {
        (0, n) => Some(n),
        (o, _) => Some(o),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn refs() -> DiffRefs {
        DiffRefs {
            base_sha: "aaaa".into(),
            start_sha: "bbbb".into(),
            head_sha: "cccc".into(),
        }
    }

    fn anchor(side: Side, line: u32, start_line: Option<u32>, start_side: Option<Side>) -> Anchor {
        Anchor {
            rev: Sha::new("cccc"),
            path: "src/lib.rs".into(),
            side,
            line,
            start_line,
            start_side,
        }
    }

    #[test]
    fn single_line_old_sets_old_line_only() {
        let pos = to_position(&anchor(Side::Old, 10, None, None), &refs());
        assert_eq!(pos.old_line, Some(10));
        assert_eq!(pos.new_line, None);
        assert!(pos.line_range.is_none());
        assert_eq!(pos.position_type, "text");
    }

    #[test]
    fn single_line_new_sets_new_line_only() {
        let pos = to_position(&anchor(Side::New, 10, None, None), &refs());
        assert_eq!(pos.old_line, None);
        assert_eq!(pos.new_line, Some(10));
    }

    #[test]
    fn carries_diff_refs_through() {
        let pos = to_position(&anchor(Side::New, 1, None, None), &refs());
        assert_eq!(pos.base_sha, "aaaa");
        assert_eq!(pos.start_sha, "bbbb");
        assert_eq!(pos.head_sha, "cccc");
    }

    #[test]
    fn multi_line_range_carries_both_endpoints() {
        let a = anchor(Side::New, 20, Some(15), Some(Side::Old));
        let pos = to_position(&a, &refs());
        let lr = pos.line_range.expect("line_range for a multi-line anchor");
        assert_eq!(lr.start.kind, Some("old".to_string()));
        assert_eq!(lr.end.kind, Some("new".to_string()));
        assert!(lr.start.line_code.ends_with("_15_0"));
        assert!(lr.end.line_code.ends_with("_0_20"));
    }

    #[test]
    fn round_trips_single_line_through_gitlab_representation() {
        let a = anchor(Side::New, 20, None, None);
        let pos = to_position(&a, &refs());
        let back = from_position(a.rev.clone(), &pos).unwrap();
        assert_eq!(back, a);
    }

    #[test]
    fn round_trips_multi_line_through_gitlab_representation() {
        let a = anchor(Side::New, 20, Some(15), Some(Side::Old));
        let pos = to_position(&a, &refs());
        let back = from_position(a.rev.clone(), &pos).unwrap();
        assert_eq!(back, a);
    }

    #[test]
    fn missing_old_and_new_line_is_rejected() {
        let pos = GitlabPosition {
            base_sha: "a".into(),
            start_sha: "b".into(),
            head_sha: "c".into(),
            old_path: "p".into(),
            new_path: "p".into(),
            position_type: "text".to_string(),
            old_line: None,
            new_line: None,
            line_range: None,
        };
        assert!(from_position(Sha::new("c"), &pos).is_none());
    }
}
