//! PR-size-scaled target group count.
//!
//! A reviewer wants "about this many logical steps", not a precise number —
//! these are deliberately coarse buckets, not a smooth formula. Driven by a
//! real large PR (77 files, ~4.3k changed lines) that got 40 groups: far too
//! many small ones for separate config/env/CI/docs edits that belonged with
//! the change they supported. Target: roughly 4-12 groups for a typical PR,
//! up to ~15 for a very large one.

/// Target `(low, high)` group count for a PR with `hunks` non-hidden hunks.
pub(crate) fn target_group_count(hunks: usize) -> (usize, usize) {
    match hunks {
        0..=8 => (2, 4),
        9..=20 => (3, 6),
        21..=45 => (4, 8),
        46..=90 => (6, 12),
        _ => (8, 15),
    }
}

/// One chunk's share of the whole-PR target (used when a large PR is split
/// into several per-directory prompts), scaled by its share of the total
/// hunks and floored at 1 so even a small chunk still gets a sensible ask.
/// The final count across all chunks is reconciled later by the merge pass
/// and the tiny-group post-pass (`coarsen::merge_tiny_groups`), so this is a
/// guideline for the model, not an enforced cap.
pub(crate) fn scaled_for_chunk(
    whole: (usize, usize),
    chunk_hunks: usize,
    total_hunks: usize,
) -> (usize, usize) {
    if total_hunks == 0 {
        return (1, 1);
    }
    let scale = |n: usize| -> usize { (n * chunk_hunks / total_hunks).max(1) };
    let lo = scale(whole.0);
    let hi = scale(whole.1).max(lo);
    (lo, hi)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounds_are_monotonically_nondecreasing_with_size() {
        let sizes = [0, 1, 8, 9, 20, 21, 45, 46, 90, 91, 500, 5000];
        let mut prev = (0, 0);
        for n in sizes {
            let (lo, hi) = target_group_count(n);
            assert!(lo <= hi, "lo <= hi for {n} hunks");
            assert!(lo >= prev.0, "low bound regressed at {n} hunks");
            assert!(hi >= prev.1, "high bound regressed at {n} hunks");
            prev = (lo, hi);
        }
    }

    #[test]
    fn typical_pr_targets_roughly_four_to_twelve() {
        // a PR in the "typical" range (goal: "4-12 groups for a typical PR").
        let (lo, hi) = target_group_count(30);
        assert!((3..=12).contains(&lo));
        assert!((4..=12).contains(&hi));
    }

    #[test]
    fn very_large_pr_caps_around_fifteen() {
        // migratro#77-sized PR: 77 files, ~4.3k changed lines -> well into
        // the hundreds of hunks.
        let (_, hi) = target_group_count(300);
        assert!(
            hi <= 15,
            "very large PRs should cap near 15 groups, got {hi}"
        );
    }

    #[test]
    fn scaled_for_chunk_floors_at_one() {
        let whole = target_group_count(50);
        let (lo, hi) = scaled_for_chunk(whole, 1, 500);
        assert_eq!(lo, 1);
        assert!(hi >= 1);
    }

    #[test]
    fn scaled_for_chunk_matches_whole_for_the_only_chunk() {
        let whole = target_group_count(40);
        let scaled = scaled_for_chunk(whole, 40, 40);
        assert_eq!(scaled, whole);
    }

    #[test]
    fn scaled_for_chunk_handles_empty_total_without_dividing_by_zero() {
        assert_eq!(scaled_for_chunk((2, 4), 0, 0), (1, 1));
    }
}
