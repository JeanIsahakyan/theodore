//! Linear issue-key detection (`ABC-123`) in free text: a PR's title, head
//! branch name and body are all places a reviewer or the PR author would
//! naturally mention the issue a change closes.

use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;

/// Linear identifiers are always upper-case team key + dash + number
/// (`ENG-123`); the team key itself is at least two characters. Wrapped in
/// `\b` so e.g. the `123` in `v2ABC-123` or a key glued to other text isn't
/// half-matched.
static ISSUE_KEY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\b[A-Z][A-Z0-9]+-\d+\b").expect("valid regex"));

/// Every distinct Linear issue key found across `title`, `head_branch` and
/// `body`, in first-seen order (title first, then branch, then body).
/// Case-sensitive on purpose: Linear identifiers are canonically upper-case,
/// so a lower-cased lookalike (common in slugified branch names) is not
/// treated as a reference.
pub fn find_issue_keys(title: &str, head_branch: &str, body: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for text in [title, head_branch, body] {
        for m in ISSUE_KEY.find_iter(text) {
            let key = m.as_str().to_string();
            if seen.insert(key.clone()) {
                out.push(key);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_a_key_in_the_title() {
        assert_eq!(
            find_issue_keys("Fix the thing (ENG-123)", "", ""),
            vec!["ENG-123"]
        );
    }

    #[test]
    fn finds_a_key_in_the_branch() {
        assert_eq!(
            find_issue_keys("", "jean/ENG-456-fix-thing", ""),
            vec!["ENG-456"]
        );
    }

    #[test]
    fn finds_a_key_in_the_body() {
        assert_eq!(
            find_issue_keys("", "", "Closes ENG-789.\n\nSee also ENG-790."),
            vec!["ENG-789", "ENG-790"]
        );
    }

    #[test]
    fn dedups_a_key_seen_in_more_than_one_field() {
        assert_eq!(
            find_issue_keys("ENG-123: fix it", "jean/ENG-123-fix-it", "Closes ENG-123"),
            vec!["ENG-123"]
        );
    }

    #[test]
    fn preserves_first_seen_order_across_fields() {
        assert_eq!(
            find_issue_keys("ENG-2 and ENG-1", "", "ENG-3"),
            vec!["ENG-2", "ENG-1", "ENG-3"]
        );
    }

    #[test]
    fn ignores_a_lowercase_lookalike() {
        assert_eq!(
            find_issue_keys("", "jean/eng-123-fix-thing", ""),
            Vec::<String>::new()
        );
    }

    #[test]
    fn ignores_a_single_letter_prefix() {
        // `[A-Z][A-Z0-9]+` requires at least two characters before the dash.
        assert_eq!(find_issue_keys("A-123", "", ""), Vec::<String>::new());
    }

    #[test]
    fn ignores_a_key_with_no_word_boundary() {
        assert_eq!(find_issue_keys("xENG-123", "", ""), Vec::<String>::new());
    }

    #[test]
    fn no_match_returns_empty() {
        assert_eq!(
            find_issue_keys("just a title", "main", "no refs here"),
            Vec::<String>::new()
        );
    }
}
