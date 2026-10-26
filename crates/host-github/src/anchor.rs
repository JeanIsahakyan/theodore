//! Domain `Anchor` ⇄ GitHub diff position (plan §6.3).
//!
//! GitHub's `DiffSide` is `LEFT` (base/old) or `RIGHT` (head/new); `line` is
//! the end of a (possibly single-line) range, `startLine`/`startSide` the
//! start. The domain's `Anchor` carries the commit the position was made
//! against separately (`rev`) — GitHub ties that to the review's `commitOID`
//! when creating a thread, and to the comment's `commit`/`originalCommit`
//! when reading one back.

use theodore_domain::{Anchor, Sha, Side};

pub(crate) fn side_to_github(side: Side) -> &'static str {
    match side {
        Side::Old => "LEFT",
        Side::New => "RIGHT",
    }
}

pub(crate) fn side_from_github(side: &str) -> Option<Side> {
    match side {
        "LEFT" => Some(Side::Old),
        "RIGHT" => Some(Side::New),
        _ => None,
    }
}

/// What goes into a `DraftPullRequestReviewThread` (or
/// `addPullRequestReviewThreadReply`'s positioning, where applicable).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct GithubPosition {
    pub path: String,
    pub line: u32,
    pub side: &'static str,
    pub start_line: Option<u32>,
    pub start_side: Option<&'static str>,
}

pub(crate) fn to_github(anchor: &Anchor) -> GithubPosition {
    GithubPosition {
        path: anchor.path.clone(),
        line: anchor.line,
        side: side_to_github(anchor.side),
        start_line: anchor.start_line,
        start_side: anchor.start_side.map(side_to_github),
    }
}

/// Reconstructs the domain anchor from a `PullRequestReviewThread` (or a
/// review comment carrying the same fields). `rev` is the commit the caller
/// already resolved (thread's `comments[0].originalCommit.oid` for an
/// outdated thread, `commit.oid` otherwise).
pub(crate) fn from_github(
    rev: Sha,
    path: &str,
    side: &str,
    line: u32,
    start_line: Option<u32>,
    start_side: Option<&str>,
) -> Option<Anchor> {
    Some(Anchor {
        rev,
        path: path.to_string(),
        side: side_from_github(side)?,
        line,
        start_line,
        start_side: start_side.and_then(side_from_github),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn anchor(side: Side, line: u32, start_line: Option<u32>, start_side: Option<Side>) -> Anchor {
        Anchor {
            rev: Sha::new("deadbeef"),
            path: "src/lib.rs".into(),
            side,
            line,
            start_line,
            start_side,
        }
    }

    #[test]
    fn single_line_old_maps_to_left() {
        let a = anchor(Side::Old, 10, None, None);
        let pos = to_github(&a);
        assert_eq!(
            pos,
            GithubPosition {
                path: "src/lib.rs".into(),
                line: 10,
                side: "LEFT",
                start_line: None,
                start_side: None
            }
        );
    }

    #[test]
    fn single_line_new_maps_to_right() {
        let a = anchor(Side::New, 10, None, None);
        assert_eq!(to_github(&a).side, "RIGHT");
    }

    #[test]
    fn multi_line_range_carries_start_side() {
        let a = anchor(Side::New, 20, Some(15), Some(Side::Old));
        let pos = to_github(&a);
        assert_eq!(pos.start_line, Some(15));
        assert_eq!(pos.start_side, Some("LEFT"));
    }

    #[test]
    fn round_trips_through_github_representation() {
        let a = anchor(Side::New, 20, Some(15), Some(Side::Old));
        let pos = to_github(&a);
        let back = from_github(
            a.rev.clone(),
            &pos.path,
            pos.side,
            pos.line,
            pos.start_line,
            pos.start_side,
        )
        .unwrap();
        assert_eq!(back, a);
    }

    #[test]
    fn unknown_side_string_is_rejected() {
        assert_eq!(side_from_github("BOTH"), None);
        assert!(from_github(Sha::new("x"), "p", "BOTH", 1, None, None).is_none());
    }
}
