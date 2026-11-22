//! The one trailer every commit Theodore writes carries (docs/spaces.md
//! §6 "Author"): the user stays the author and committer, and
//! `Co-authored-by: Theodore <noreply@theodore.cloud>` says who typed it
//! out. Applied where the commits are made — the shipped squash
//! (`ship.rs`), a local folder's merge commit, a committed suggestion or
//! applied fix (`worktree.rs`), a config file committed or proposed
//! (`config_file.rs`) — never to a space's own checkpoints, which are
//! Theodore's internal snapshots and never leave the cache as they are.

/// The trailer line, exactly as git shows it.
pub const CO_AUTHOR: &str = "Co-authored-by: Theodore <noreply@theodore.cloud>";

/// `message` with `CO_AUTHOR` as its last trailer, once: a message that
/// already has it (any case, any spacing) is returned trimmed and
/// unchanged; one whose last paragraph is already a trailer block gets the
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
    key.trim().eq_ignore_ascii_case("co-authored-by")
        && value
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .eq_ignore_ascii_case("Theodore <noreply@theodore.cloud>")
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
            "Retry on 429s\n\nCo-authored-by: Theodore <noreply@theodore.cloud>"
        );
        assert_eq!(
            with_co_author("Retry on 429s\n\nWith backoff.\n"),
            "Retry on 429s\n\nWith backoff.\n\nCo-authored-by: Theodore <noreply@theodore.cloud>"
        );
        assert_eq!(with_co_author(""), CO_AUTHOR);
    }

    #[test]
    fn the_trailer_joins_an_existing_trailer_block() {
        assert_eq!(
            with_co_author("Fix it\n\nBody.\n\nSigned-off-by: Ada <ada@example.com>"),
            "Fix it\n\nBody.\n\nSigned-off-by: Ada <ada@example.com>\n\
             Co-authored-by: Theodore <noreply@theodore.cloud>"
        );
        // A subject that looks like a trailer is still the subject.
        assert_eq!(
            with_co_author("fix: retry"),
            "fix: retry\n\nCo-authored-by: Theodore <noreply@theodore.cloud>"
        );
    }

    #[test]
    fn the_trailer_is_never_doubled() {
        let once = with_co_author("Fix it");
        assert_eq!(with_co_author(&once), once);
        let spaced = "Fix it\n\nco-authored-by:  Theodore   <noreply@theodore.cloud>";
        assert_eq!(with_co_author(spaced), spaced);
        // Another co-author is kept, and Theodore joins.
        let other = "Fix it\n\nCo-authored-by: Ada <ada@example.com>";
        assert_eq!(with_co_author(other), format!("{other}\n{CO_AUTHOR}"));
    }
}
