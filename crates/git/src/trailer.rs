//! The trailers every commit Theodore writes carries (docs/spaces.md §6
//! "Author"): the user stays the author and committer, and two
//! `Co-authored-by: Theodore <…>` lines say who typed it out — first the
//! GitHub App `theodore-cloud[bot]`'s noreply address, which GitHub links
//! to the app and shows with its avatar, then `noreply@theodore.cloud`,
//! Theodore's own address, shown by name. Applied where the commits are
//! made — the shipped squash (`ship.rs`), a local folder's merge commit, a
//! committed suggestion or applied fix (`worktree.rs`), a config file
//! committed or proposed (`config_file.rs`) — never to a space's own
//! checkpoints, which are Theodore's internal snapshots and never leave
//! the cache as they are.

/// Who co-authors, in the order the lines are written: name and address,
/// in one place. The first is the GitHub App's bot user (id 359906112).
pub const THEODORE_CO_AUTHORS: [&str; 2] = [
    "Theodore <359906112+theodore-cloud[bot]@users.noreply.github.com>",
    "Theodore <noreply@theodore.cloud>",
];

/// The trailer key, as git spells it.
const KEY: &str = "Co-authored-by";

/// Both trailer lines, exactly as git shows them (`%(trailers:only)`).
pub const CO_AUTHOR: &str = "Co-authored-by: Theodore <359906112+theodore-cloud[bot]@users.noreply.github.com>\n\
                             Co-authored-by: Theodore <noreply@theodore.cloud>";

/// `message` with every line of `THEODORE_CO_AUTHORS` among its trailers,
/// each once: a line the message already has (any case, any spacing) isn't
/// added again, the missing ones are. They join a trailer block the message
/// already ends with, else make a block of their own after a blank line,
/// as `git interpret-trailers` would place them.
pub fn with_co_author(message: &str) -> String {
    let mut out = message.trim_end().to_string();
    let missing: Vec<&str> = THEODORE_CO_AUTHORS
        .iter()
        .copied()
        .filter(|who| !out.lines().any(|l| is_co_author(l, who)))
        .collect();
    if missing.is_empty() {
        return out;
    }
    let mut sep = if out.is_empty() {
        ""
    } else if ends_in_trailer_block(&out) {
        "\n"
    } else {
        "\n\n"
    };
    for who in missing {
        out.push_str(sep);
        out.push_str(KEY);
        out.push_str(": ");
        out.push_str(who);
        sep = "\n";
    }
    out
}

/// `line` is `Co-authored-by: <who>`, whatever the case and spacing.
fn is_co_author(line: &str, who: &str) -> bool {
    let Some((key, value)) = line.split_once(':') else {
        return false;
    };
    key.trim().eq_ignore_ascii_case(KEY)
        && value
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .eq_ignore_ascii_case(who)
}

/// A `Key: value` line, as git's trailer parser sees one (a token of
/// letters and dashes before the colon).
fn is_trailer_line(line: &str) -> bool {
    let Some((key, _)) = line.split_once(':') else {
        return false;
    };
    !key.is_empty() && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// The message's last paragraph is all trailers, and isn't its subject.
fn ends_in_trailer_block(message: &str) -> bool {
    let Some(last) = message.rsplit("\n\n").next() else {
        return false;
    };
    last.len() < message.len() && last.lines().all(is_trailer_line)
}

#[cfg(test)]
mod tests {
    use super::*;

    const BOT: &str =
        "Co-authored-by: Theodore <359906112+theodore-cloud[bot]@users.noreply.github.com>";
    const PLAIN: &str = "Co-authored-by: Theodore <noreply@theodore.cloud>";

    #[test]
    fn both_trailers_are_added_after_a_blank_line_in_order() {
        assert_eq!(CO_AUTHOR, format!("{BOT}\n{PLAIN}"));
        assert_eq!(
            with_co_author("Retry on 429s"),
            format!("Retry on 429s\n\n{BOT}\n{PLAIN}")
        );
        assert_eq!(
            with_co_author("Retry on 429s\n\nWith backoff.\n"),
            format!("Retry on 429s\n\nWith backoff.\n\n{CO_AUTHOR}")
        );
        assert_eq!(with_co_author(""), CO_AUTHOR);
    }

    #[test]
    fn the_trailers_join_an_existing_trailer_block() {
        assert_eq!(
            with_co_author("Fix it\n\nBody.\n\nSigned-off-by: Ada <ada@example.com>"),
            format!("Fix it\n\nBody.\n\nSigned-off-by: Ada <ada@example.com>\n{CO_AUTHOR}")
        );
        // A subject that looks like a trailer is still the subject.
        assert_eq!(
            with_co_author("fix: retry"),
            format!("fix: retry\n\n{CO_AUTHOR}")
        );
    }

    #[test]
    fn each_line_is_added_at_most_once() {
        let once = with_co_author("Fix it");
        assert_eq!(with_co_author(&once), once);
        // Only the bot line present (any case, any spacing): the plain one joins.
        let spaced = "Fix it\n\nco-authored-by:  Theodore   <359906112+THEODORE-cloud[bot]@users.noreply.github.com>";
        assert_eq!(with_co_author(spaced), format!("{spaced}\n{PLAIN}"));
        // Only the plain line (an earlier build's commit): the bot one joins.
        let old = format!("Fix it\n\n{PLAIN}");
        assert_eq!(with_co_author(&old), format!("{old}\n{BOT}"));
        // Another co-author is kept, and Theodore joins.
        let other = "Fix it\n\nCo-authored-by: Ada <ada@example.com>";
        assert_eq!(with_co_author(other), format!("{other}\n{CO_AUTHOR}"));
    }
}
