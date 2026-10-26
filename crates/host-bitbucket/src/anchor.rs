//! Domain `Anchor` <-> Bitbucket inline comment `inline{path,to,from}` (plan
//! §6.3). Bitbucket's inline position is a single line per comment — no
//! multi-line range the way GitHub's `start_line` or GitLab's `line_range`
//! are — so a multi-line `Anchor` (`start_line`/`start_side` set) collapses
//! to its end point on write; reading back never produces one.

use theodore_domain::{Anchor, Sha, Side};

use crate::model::BbInline;

pub(crate) fn to_inline(anchor: &Anchor) -> BbInline {
    match anchor.side {
        Side::New => BbInline {
            path: anchor.path.clone(),
            to: Some(anchor.line),
            from: None,
        },
        Side::Old => BbInline {
            path: anchor.path.clone(),
            to: None,
            from: Some(anchor.line),
        },
    }
}

/// `rev` is the head sha the caller already resolved for the PR (Bitbucket's
/// inline position carries no commit sha of its own).
pub(crate) fn from_inline(rev: Sha, inline: &BbInline) -> Option<Anchor> {
    let (side, line) = match (inline.to, inline.from) {
        (Some(l), _) => (Side::New, l),
        (None, Some(l)) => (Side::Old, l),
        (None, None) => return None,
    };
    Some(Anchor {
        rev,
        path: inline.path.clone(),
        side,
        line,
        start_line: None,
        start_side: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn anchor(side: Side, line: u32) -> Anchor {
        Anchor {
            rev: Sha::new("cccc"),
            path: "src/lib.rs".into(),
            side,
            line,
            start_line: None,
            start_side: None,
        }
    }

    #[test]
    fn new_side_sets_to_line() {
        let inline = to_inline(&anchor(Side::New, 10));
        assert_eq!(inline.to, Some(10));
        assert_eq!(inline.from, None);
    }

    #[test]
    fn old_side_sets_from_line() {
        let inline = to_inline(&anchor(Side::Old, 10));
        assert_eq!(inline.from, Some(10));
        assert_eq!(inline.to, None);
    }

    #[test]
    fn round_trips_through_bitbucket_representation() {
        let a = anchor(Side::New, 20);
        let inline = to_inline(&a);
        assert_eq!(from_inline(a.rev.clone(), &inline), Some(a));
    }

    #[test]
    fn missing_to_and_from_is_rejected() {
        let inline = BbInline {
            path: "p".into(),
            to: None,
            from: None,
        };
        assert_eq!(from_inline(Sha::new("c"), &inline), None);
    }
}
