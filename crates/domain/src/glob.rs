//! Path globs for the project config's `review:` keys (docs/config.md).
//!
//! ```text
//! *.lock        no `/`: the file name, at any depth
//! gen/**        anchored at the repo root; `**` is any number of segments
//! docs/         a trailing `/`: everything under it
//! src/*.rs      `*` and `?` stay inside one segment
//! *.{ts,tsx}    `{a,b}` alternatives
//! ```

/// Whether repo-relative `path` matches `pattern`.
pub fn glob_match(pattern: &str, path: &str) -> bool {
    expand_braces(pattern)
        .iter()
        .any(|p| match_expanded(p, path))
}

/// Whether `s` has any glob syntax (as opposed to a plain path).
pub fn is_glob(s: &str) -> bool {
    s.contains(['*', '?', '{'])
}

/// More alternatives than this is a typo, not a pattern.
const MAX_EXPANSIONS: usize = 64;

fn expand_braces(pattern: &str) -> Vec<String> {
    let mut out = Vec::new();
    expand_into(pattern, &mut out);
    if out.is_empty() {
        out.push(pattern.to_string());
    }
    out
}

fn expand_into(pattern: &str, out: &mut Vec<String>) {
    if out.len() >= MAX_EXPANSIONS {
        return;
    }
    let Some(open) = pattern.find('{') else {
        out.push(pattern.to_string());
        return;
    };
    // The matching `}` and the top-level commas between.
    let mut depth = 0usize;
    let mut commas = Vec::new();
    let mut close = None;
    for (i, c) in pattern[open..].char_indices() {
        let i = open + i;
        match c {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    close = Some(i);
                    break;
                }
            }
            ',' if depth == 1 => commas.push(i),
            _ => {}
        }
    }
    let Some(close) = close else {
        // Unbalanced: a literal `{`.
        out.push(pattern.to_string());
        return;
    };
    let (head, tail) = (&pattern[..open], &pattern[close + 1..]);
    let mut start = open + 1;
    let mut parts = Vec::new();
    for c in commas.into_iter().chain(std::iter::once(close)) {
        parts.push(&pattern[start..c]);
        start = c + 1;
    }
    for part in parts {
        expand_into(&format!("{head}{part}{tail}"), out);
    }
}

fn match_expanded(pattern: &str, path: &str) -> bool {
    let pattern = pattern.trim();
    let pattern = pattern.strip_prefix("./").unwrap_or(pattern);
    let pattern = pattern.trim_start_matches('/');
    let owned;
    let pattern = if pattern.ends_with('/') {
        owned = format!("{pattern}**");
        owned.as_str()
    } else {
        pattern
    };
    if pattern.is_empty() {
        return false;
    }
    let path = path.strip_prefix("./").unwrap_or(path);
    if !pattern.contains('/') {
        let name = path.rsplit('/').next().unwrap_or(path);
        return segment_match(pattern.as_bytes(), name.as_bytes());
    }
    let pat: Vec<&str> = pattern.split('/').filter(|s| !s.is_empty()).collect();
    let segs: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    segments_match(&pat, &segs)
}

fn segments_match(pat: &[&str], segs: &[&str]) -> bool {
    match pat.split_first() {
        None => segs.is_empty(),
        Some((&"**", rest)) => {
            // Collapse runs of `**`.
            let rest = {
                let mut r = rest;
                while r.first() == Some(&"**") {
                    r = &r[1..];
                }
                r
            };
            (0..=segs.len()).any(|i| segments_match(rest, &segs[i..]))
        }
        Some((first, rest)) => match segs.split_first() {
            Some((seg, segs)) => {
                segment_match(first.as_bytes(), seg.as_bytes()) && segments_match(rest, segs)
            }
            None => false,
        },
    }
}

/// `*` and `?` within one segment; linear backtracking on the last `*`.
fn segment_match(pat: &[u8], text: &[u8]) -> bool {
    let (mut p, mut t) = (0, 0);
    let mut star: Option<(usize, usize)> = None;
    while t < text.len() {
        if p < pat.len() && (pat[p] == b'?' || pat[p] == text[t]) {
            p += 1;
            t += 1;
        } else if p < pat.len() && pat[p] == b'*' {
            star = Some((p, t));
            p += 1;
        } else if let Some((sp, st)) = star {
            p = sp + 1;
            t = st + 1;
            star = Some((sp, st + 1));
        } else {
            return false;
        }
    }
    while p < pat.len() && pat[p] == b'*' {
        p += 1;
    }
    p == pat.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_name_without_a_slash_matches_at_any_depth() {
        assert!(glob_match("*.lock", "Cargo.lock"));
        assert!(glob_match("*.lock", "a/b/yarn.lock"));
        assert!(!glob_match("*.lock", "a/lock/x.rs"));
        assert!(glob_match("Makefile", "sub/Makefile"));
    }

    #[test]
    fn a_slash_anchors_at_the_root() {
        assert!(glob_match("gen/**", "gen/a/b.ts"));
        assert!(!glob_match("gen/**", "src/gen/a.ts"));
        assert!(glob_match("**/gen/**", "src/gen/a.ts"));
        assert!(glob_match("/src/*.rs", "src/lib.rs"));
        assert!(!glob_match("src/*.rs", "src/a/lib.rs"));
        assert!(glob_match("src/**/*.rs", "src/lib.rs"));
        assert!(glob_match("src/**/*.rs", "src/a/b/lib.rs"));
        assert!(glob_match("docs/", "docs/a/b.md"));
        assert!(glob_match("**/*.snap", "a/__snapshots__/x.snap"));
    }

    #[test]
    fn question_marks_braces_and_literals() {
        assert!(glob_match("v?.txt", "v1.txt"));
        assert!(!glob_match("v?.txt", "v10.txt"));
        assert!(glob_match("**/*.{ts,tsx}", "ui/a.tsx"));
        assert!(glob_match("**/*.{ts,tsx}", "ui/a.ts"));
        assert!(!glob_match("**/*.{ts,tsx}", "ui/a.js"));
        assert!(glob_match("{a,b/{c,d}}/x", "b/d/x"));
        assert!(glob_match("migrations/0001.sql", "migrations/0001.sql"));
        assert!(!glob_match("", "a"));
        assert!(glob_match("weird{", "weird{"));
    }

    #[test]
    fn stars_backtrack_within_a_segment() {
        assert!(glob_match("*a*b*c", "xaxbxbxc"));
        assert!(!glob_match("*a*b*c", "xaxbxbx"));
        assert!(glob_match("**", "any/thing"));
    }
}
