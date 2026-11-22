//! The one trailer every commit Theodore writes carries (docs/spaces.md
//! §6 "Author"): the user stays the author and committer, and
//! `Co-authored-by: Theodore <…theodore-cloud[bot]@users.noreply.github.com>`
//! says who typed it out — the GitHub App's own noreply address, so GitHub
//! links the co-author to `theodore-cloud[bot]` and shows its avatar. Applied where the commits are made — the shipped squash
//! (`ship.rs`), a local folder's merge commit, a committed suggestion or
//! applied fix (`worktree.rs`), a config file committed or proposed
//! (`config_file.rs`) — never to a space's own checkpoints, which are
//! Theodore's internal snapshots and never leave the cache as they are.

/// Who co-authors: the name and the GitHub App `theodore-cloud[bot]`'s
/// noreply address (bot user id 359906112), in one place.
pub const THEODORE_CO_AUTHOR: &str =
    "Theodore <359906112+theodore-cloud[bot]@users.noreply.github.com>";
/// The trailer line, exactly as git shows it.
pub const CO_AUTHOR: &str =
    "Co-authored-by: Theodore <359906112+theodore-cloud[bot]@users.noreply.github.com>";
/// The address earlier builds wrote: a commit that has it isn't given a
/// second Theodore line.
const OLD_CO_AUTHOR: &str = "Theodore <noreply@theodore.cloud>";

/// `message` with `CO_AUTHOR` as its last trailer, once: a message that
/// already has it, or the old `noreply@theodore.cloud` form (any case, any
/// spacing), is returned trimmed and unchanged; one whose last paragraph is already a trailer block gets the
/// line appended to it, else the trailer makes a block of its own after a
/// blank line, as `git interpret-trailers` would place it.
pub fn with_co_author(message: &str) -> String {
    let message = message.trim_end();
    if message.lines().any(is_the_trailer) {
        return message.to_string();
    }
    if message.is_empty() {
        return CO_AUTHOR.to_string();
    }
    let sep = if ends_in_trailer_block(message) {
        "\n"
    } else {
        "\n\n"
    };
    format!("{message}{sep}{CO_AUTHOR}")
}

fn is_the_trailer(line: &str) -> bool {
    let Some((key, value)) = line.split_once(':') else {
        return false;
    };
    if !key.trim().eq_ignore_ascii_case("co-authored-by") {
        return false;
    }
    let who = value.split_whitespace().collect::<Vec<_>>().join(" ");
    who.eq_ignore_ascii_case(THEODORE_CO_AUTHOR) || who.eq_ignore_ascii_case(OLD_CO_AUTHOR)
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

    #[test]
    fn the_trailer_is_added_after_a_blank_line() {
        assert_eq!(
            with_co_author("Retry on 429s"),
            format!("Retry on 429s\n\n{CO_AUTHOR}")
        );
        assert_eq!(
            with_co_author("Retry on 429s\n\nWith backoff.\n"),
            format!("Retry on 429s\n\nWith backoff.\n\n{CO_AUTHOR}")
        );
        assert_eq!(CO_AUTHOR, format!("Co-authored-by: {THEODORE_CO_AUTHOR}"));
        assert_eq!(with_co_author(""), CO_AUTHOR);
    }

    #[test]
    fn the_trailer_joins_an_existing_trailer_block() {
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
    fn the_trailer_is_never_doubled() {
        let once = with_co_author("Fix it");
        assert_eq!(with_co_author(&once), once);
        let spaced = "Fix it\n\nco-authored-by:  Theodore   <359906112+THEODORE-cloud[bot]@users.noreply.github.com>";
        assert_eq!(with_co_author(spaced), spaced);
        // The address earlier builds wrote counts as Theodore's too.
        let old = "Fix it\n\nCo-authored-by: Theodore <noreply@theodore.cloud>";
        assert_eq!(with_co_author(old), old);
        // Another co-author is kept, and Theodore joins.
        let other = "Fix it\n\nCo-authored-by: Ada <ada@example.com>";
        assert_eq!(with_co_author(other), format!("{other}\n{CO_AUTHOR}"));
    }
}
