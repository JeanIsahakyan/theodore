//! Groups out of an answer still being written: feed the text as it
//! arrives, get each group object the moment its closing `}` does.
//!
//! ```text
//! prose / ```json fence ─▶ `"groups"` `:` `[` found ─▶ scan objects
//!   depth 0 `{` ─▶ object starts       (strings and escapes skipped)
//!   back to depth 0 `}` ─▶ parse as RawGroup ─▶ yield
//!   depth 0 `]` ─▶ done: the rest of the text is ignored
//! ```
//!
//! A preview only: the full answer still goes through `parse_grouping`,
//! validation and repair. An object that doesn't parse as a group is
//! skipped, not an error.

use crate::schema::RawGroup;

const KEY: &str = "\"groups\"";

/// The incremental parser. Pure: no I/O, no clock.
#[derive(Debug, Default)]
pub struct GroupStream {
    buf: String,
    /// Where scanning picks up in `buf`.
    pos: usize,
    state: State,
    /// Objects yielded so far.
    yielded: usize,
}

#[derive(Debug, Default)]
enum State {
    /// Looking for `"groups"` `:` `[`.
    #[default]
    Seeking,
    /// Inside the groups array.
    Array {
        depth: u32,
        in_string: bool,
        escaped: bool,
        /// Where the current depth-1 object began.
        start: usize,
    },
    /// The array closed.
    Done,
}

impl GroupStream {
    pub fn new() -> Self {
        Self::default()
    }

    /// Groups yielded so far.
    pub fn yielded(&self) -> usize {
        self.yielded
    }

    /// Whether the groups array has closed.
    pub fn is_done(&self) -> bool {
        matches!(self.state, State::Done)
    }

    /// Takes the next piece of text; returns every group it completed.
    pub fn push(&mut self, chunk: &str) -> Vec<RawGroup> {
        if self.is_done() {
            return vec![];
        }
        self.buf.push_str(chunk);
        let mut out = Vec::new();
        loop {
            match self.state {
                State::Seeking => match self.seek() {
                    Some(after) => {
                        self.pos = after;
                        self.state = State::Array {
                            depth: 0,
                            in_string: false,
                            escaped: false,
                            start: 0,
                        };
                    }
                    None => return out,
                },
                State::Array { .. } => {
                    self.scan(&mut out);
                    return out;
                }
                State::Done => return out,
            }
        }
    }

    /// The index just past the `[` of the first `"groups" : [` from `pos`.
    /// `None` until one is complete; `pos` moves past occurrences that turn
    /// out not to be it (`"groups" is …` in prose).
    fn seek(&mut self) -> Option<usize> {
        let bytes = self.buf.as_bytes();
        loop {
            let at = self.pos + self.buf[self.pos..].find(KEY)?;
            let mut i = at + KEY.len();
            let mut colon = false;
            loop {
                match bytes.get(i) {
                    // Not all here yet: look again with more text.
                    None => {
                        self.pos = at;
                        return None;
                    }
                    Some(b) if b.is_ascii_whitespace() => i += 1,
                    Some(b':') if !colon => {
                        colon = true;
                        i += 1;
                    }
                    Some(b'[') if colon => return Some(i + 1),
                    Some(_) => break,
                }
            }
            self.pos = at + KEY.len();
        }
    }

    fn scan(&mut self, out: &mut Vec<RawGroup>) {
        let State::Array {
            mut depth,
            mut in_string,
            mut escaped,
            mut start,
        } = self.state
        else {
            return;
        };
        let bytes = self.buf.as_bytes();
        let mut i = self.pos;
        while i < bytes.len() {
            let b = bytes[i];
            i += 1;
            if in_string {
                if escaped {
                    escaped = false;
                } else if b == b'\\' {
                    escaped = true;
                } else if b == b'"' {
                    in_string = false;
                }
                continue;
            }
            match b {
                b'"' => in_string = true,
                b'{' | b'[' => {
                    if depth == 0 && b == b'{' {
                        start = i - 1;
                    }
                    depth += 1;
                }
                b'}' | b']' if depth > 0 => {
                    depth -= 1;
                    if depth == 0
                        && b == b'}'
                        && let Ok(g) = serde_json::from_str::<RawGroup>(&self.buf[start..i])
                    {
                        out.push(g);
                        self.yielded += 1;
                    }
                }
                b']' => {
                    self.state = State::Done;
                    self.pos = i;
                    return;
                }
                _ => {}
            }
        }
        self.pos = i;
        self.state = State::Array {
            depth,
            in_string,
            escaped,
            start,
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(gs: &[RawGroup]) -> Vec<&str> {
        gs.iter().map(|g| g.id.as_str()).collect()
    }

    /// Feeds `text` in pieces of `n` bytes (on char boundaries) and
    /// records after which piece each group came out.
    fn feed(text: &str, n: usize) -> Vec<(usize, String)> {
        let mut s = GroupStream::new();
        let mut out = Vec::new();
        let mut piece = 0;
        let mut rest = text;
        while !rest.is_empty() {
            let mut cut = n.min(rest.len());
            while !rest.is_char_boundary(cut) {
                cut += 1;
            }
            let (head, tail) = rest.split_at(cut);
            for g in s.push(head) {
                out.push((piece, g.id));
            }
            rest = tail;
            piece += 1;
        }
        out
    }

    const ANSWER: &str = r#"{"groups": [
        {"id": "schema", "title": "Schema", "why": "adds {a} table", "hunks": ["h1", "h2"]},
        {"id": "api", "title": "API \"v2\"", "why": "a \\ backslash } and ]", "check": ["x"], "hunks": ["h3"]},
        {"id": "tests", "title": "Tests", "kind": "skim", "hunks": ["h4"]}
    ]}"#;

    #[test]
    fn yields_every_group_of_a_whole_answer() {
        let mut s = GroupStream::new();
        let gs = s.push(ANSWER);
        assert_eq!(ids(&gs), ["schema", "api", "tests"]);
        assert_eq!(gs[1].title, "API \"v2\"");
        assert_eq!(gs[1].why, "a \\ backslash } and ]");
        assert!(s.is_done());
    }

    #[test]
    fn yields_each_group_as_soon_as_it_closes_whatever_the_split() {
        for n in [1, 2, 3, 7, 16, 64] {
            let got = feed(ANSWER, n);
            let names: Vec<&str> = got.iter().map(|(_, id)| id.as_str()).collect();
            assert_eq!(names, ["schema", "api", "tests"], "pieces of {n}");
            // Each one out on the piece holding its closing brace.
            let closes: Vec<usize> = ANSWER
                .match_indices("]}")
                .map(|(i, _)| i + 1)
                .take(3)
                .collect();
            let want: Vec<usize> = closes.iter().map(|c| c / n).collect();
            let at: Vec<usize> = got.iter().map(|(p, _)| *p).collect();
            assert_eq!(at, want, "pieces of {n}");
        }
    }

    #[test]
    fn nothing_before_the_first_object_closes() {
        let mut s = GroupStream::new();
        assert!(
            s.push(r#"{"groups": [{"id": "a", "hunks": ["h1""#)
                .is_empty()
        );
        assert_eq!(ids(&s.push(r#"]}, {"id": "b""#)), ["a"]);
        assert_eq!(ids(&s.push(r#", "hunks": []}]}"#)), ["b"]);
    }

    #[test]
    fn tolerates_a_fence_and_prose_before_and_after() {
        let text = format!(
            "Here is the grouping (the \"groups\" key):\n```json\n{ANSWER}\n```\nDone, {{\"groups\": [{{\"id\": \"nope\"}}]}}"
        );
        for n in [1, 5, 1000] {
            let got: Vec<String> = feed(&text, n).into_iter().map(|(_, id)| id).collect();
            assert_eq!(got, ["schema", "api", "tests"], "pieces of {n}");
        }
    }

    #[test]
    fn the_key_split_across_pieces_is_still_found() {
        let mut s = GroupStream::new();
        assert!(s.push("{\"gro").is_empty());
        assert!(s.push("ups\"").is_empty());
        assert!(s.push(" \n: ").is_empty());
        assert_eq!(ids(&s.push("[{\"id\":\"a\"}]}")), ["a"]);
    }

    #[test]
    fn an_object_that_is_not_a_group_is_skipped() {
        let mut s = GroupStream::new();
        let gs = s.push(r#"{"groups": [{"title": "no id"}, {"id": "ok"}, 3, "x"]}"#);
        assert_eq!(ids(&gs), ["ok"]);
        assert_eq!(s.yielded(), 1);
    }

    #[test]
    fn non_ascii_text_is_fine() {
        let text = r#"{"groups": [{"id": "ü", "title": "Größe — 改善 🎉", "hunks": []}]}"#;
        let got: Vec<String> = feed(text, 1).into_iter().map(|(_, id)| id).collect();
        assert_eq!(got, ["ü"]);
    }

    #[test]
    fn garbage_yields_nothing() {
        let mut s = GroupStream::new();
        assert!(s.push("I can't do that {not json} [nor this]").is_empty());
        assert!(!s.is_done());
    }
}
