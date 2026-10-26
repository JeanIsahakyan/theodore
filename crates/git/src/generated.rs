//! Flags files that shouldn't be read hunk-by-hunk: known lockfiles,
//! minified bundles, snapshot fixtures, and anything `.gitattributes` marks
//! `linguist-generated` or routes through git-lfs.

const LOCKFILE_BASENAMES: &[&str] = &[
    "Cargo.lock",
    "pnpm-lock.yaml",
    "package-lock.json",
    "yarn.lock",
    "go.sum",
    "Gemfile.lock",
    "poetry.lock",
];

/// `Some(reason)` if `path` is a known generated/vendored file by name alone
/// (no `.gitattributes` needed).
pub(crate) fn generated_by_name(path: &str) -> Option<String> {
    let base = path.rsplit('/').next().unwrap_or(path);
    if LOCKFILE_BASENAMES.contains(&base) {
        return Some(format!("lockfile ({base})"));
    }
    if base.ends_with(".min.js") {
        return Some("minified bundle".to_string());
    }
    if base.ends_with(".snap") {
        return Some("snapshot fixture".to_string());
    }
    None
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum AttrValue {
    Set,
    Unset,
    Value(String),
}

/// A parsed `.gitattributes` file: pattern → attribute settings, in file
/// order. Git semantics: the *last* matching pattern for a given attribute
/// wins, so lookups walk rules in order and keep overwriting.
#[derive(Debug, Default, Clone)]
pub(crate) struct GitAttributes {
    rules: Vec<(String, Vec<(String, AttrValue)>)>,
}

impl GitAttributes {
    pub(crate) fn parse(content: &str) -> Self {
        let mut rules = Vec::new();
        for line in content.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let mut parts = line.split_whitespace();
            let Some(pattern) = parts.next() else {
                continue;
            };
            let mut attrs = Vec::new();
            for tok in parts {
                let (key, value) = if let Some(rest) = tok.strip_prefix('-') {
                    (rest.to_string(), AttrValue::Unset)
                } else if let Some(rest) = tok.strip_prefix('!') {
                    (rest.to_string(), AttrValue::Unset)
                } else if let Some((k, v)) = tok.split_once('=') {
                    (k.to_string(), AttrValue::Value(v.to_string()))
                } else {
                    (tok.to_string(), AttrValue::Set)
                };
                attrs.push((key, value));
            }
            rules.push((pattern.to_string(), attrs));
        }
        Self { rules }
    }

    fn attr_value(&self, path: &str, key: &str) -> Option<&AttrValue> {
        let mut found = None;
        for (pattern, attrs) in &self.rules {
            if !matches_pattern(pattern, path) {
                continue;
            }
            for (k, v) in attrs {
                if k == key {
                    found = Some(v);
                }
            }
        }
        found
    }

    pub(crate) fn is_set(&self, path: &str, key: &str) -> bool {
        matches!(self.attr_value(path, key), Some(AttrValue::Set))
            || matches!(self.attr_value(path, key), Some(AttrValue::Value(v)) if v == "true")
    }

    pub(crate) fn value(&self, path: &str, key: &str) -> Option<&str> {
        match self.attr_value(path, key) {
            Some(AttrValue::Value(v)) => Some(v.as_str()),
            _ => None,
        }
    }
}

/// `true` if `.gitattributes` routes `path` through git-lfs
/// (`filter=lfs`).
pub(crate) fn is_lfs(attrs: &GitAttributes, path: &str) -> bool {
    attrs.value(path, "filter") == Some("lfs")
}

/// `.gitattributes`-driven generated reason (`linguist-generated`), if any.
pub(crate) fn generated_by_attr(attrs: &GitAttributes, path: &str) -> Option<String> {
    attrs
        .is_set(path, "linguist-generated")
        .then(|| "linguist-generated".to_string())
}

/// gitignore-style pattern match: no `/` matches any path segment at any
/// depth; otherwise segments are matched left to right, with `**` matching
/// zero or more whole segments. Enough for the small, hand-written patterns
/// `.gitattributes` files actually use; not a full gitignore implementation.
fn matches_pattern(pattern: &str, path: &str) -> bool {
    let anchored = pattern.starts_with('/');
    let pat = pattern.trim_start_matches('/').trim_end_matches('/');
    if pat.is_empty() {
        return false;
    }
    if !anchored && !pat.contains('/') {
        return path.split('/').any(|seg| glob_segment(pat, seg));
    }
    glob_path(pat, path)
}

fn glob_path(pattern: &str, path: &str) -> bool {
    let pat_segs: Vec<&str> = pattern.split('/').collect();
    let path_segs: Vec<&str> = path.split('/').collect();
    glob_path_rec(&pat_segs, &path_segs)
}

fn glob_path_rec(pat: &[&str], path: &[&str]) -> bool {
    match pat.first() {
        None => path.is_empty(),
        Some(&"**") => {
            if pat.len() == 1 {
                return true;
            }
            (0..=path.len()).any(|i| glob_path_rec(&pat[1..], &path[i..]))
        }
        Some(seg) => match path.first() {
            Some(first) if glob_segment(seg, first) => glob_path_rec(&pat[1..], &path[1..]),
            _ => false,
        },
    }
}

/// `*`/`?` wildcard match within one path segment (no `/`).
fn glob_segment(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    let mut dp = vec![vec![false; t.len() + 1]; p.len() + 1];
    dp[0][0] = true;
    for i in 0..p.len() {
        if p[i] == '*' {
            dp[i + 1][0] = dp[i][0];
        }
    }
    for i in 0..p.len() {
        for j in 0..=t.len() {
            if !dp[i][j] {
                continue;
            }
            match p[i] {
                '*' => {
                    dp[i + 1][j] = true;
                    if j < t.len() {
                        dp[i][j + 1] = true;
                    }
                }
                '?' => {
                    if j < t.len() {
                        dp[i + 1][j + 1] = true;
                    }
                }
                c => {
                    if j < t.len() && t[j] == c {
                        dp[i + 1][j + 1] = true;
                    }
                }
            }
        }
    }
    dp[p.len()][t.len()]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lockfile_by_basename() {
        assert_eq!(
            generated_by_name("Cargo.lock"),
            Some("lockfile (Cargo.lock)".to_string())
        );
        assert_eq!(
            generated_by_name("sub/dir/pnpm-lock.yaml"),
            Some("lockfile (pnpm-lock.yaml)".to_string())
        );
        assert_eq!(generated_by_name("src/main.rs"), None);
    }

    #[test]
    fn minified_and_snapshot() {
        assert!(generated_by_name("dist/app.min.js").is_some());
        assert!(generated_by_name("__snapshots__/a.snap").is_some());
    }

    #[test]
    fn glob_star_matches_within_segment() {
        // `glob_segment` operates on one already-split path segment (no
        // `/`); slash-crossing is rejected one level up, by `matches_pattern`
        // splitting the path into segments before calling it.
        assert!(glob_segment("*.min.js", "app.min.js"));
        assert!(!glob_segment("*.min.js", "app.min.js.bak"));
        assert!(!matches_pattern("*.min.js", "dir/app.min.js.bak"));
    }

    #[test]
    fn pattern_without_slash_matches_any_depth() {
        assert!(matches_pattern("*.generated.go", "a/b/x.generated.go"));
        assert!(matches_pattern("vendor", "vendor"));
    }

    #[test]
    fn anchored_pattern_matches_from_root() {
        assert!(matches_pattern("/dist/*.js", "dist/a.js"));
        assert!(!matches_pattern("/dist/*.js", "sub/dist/a.js"));
    }

    #[test]
    fn doublestar_crosses_segments() {
        assert!(matches_pattern("vendor/**", "vendor/a/b/c.go"));
        assert!(matches_pattern("**/generated/*.rs", "a/b/generated/x.rs"));
    }

    #[test]
    fn linguist_generated_attribute() {
        let attrs =
            GitAttributes::parse("*.pb.go linguist-generated=true\nother.go -linguist-generated\n");
        assert_eq!(
            generated_by_attr(&attrs, "models.pb.go"),
            Some("linguist-generated".to_string())
        );
        assert_eq!(generated_by_attr(&attrs, "other.go"), None);
        assert_eq!(generated_by_attr(&attrs, "plain.go"), None);
    }

    #[test]
    fn lfs_filter_attribute() {
        let attrs = GitAttributes::parse("*.psd filter=lfs diff=lfs merge=lfs -text\n");
        assert!(is_lfs(&attrs, "art/cover.psd"));
        assert!(!is_lfs(&attrs, "art/cover.png"));
    }

    #[test]
    fn last_matching_rule_wins() {
        let attrs = GitAttributes::parse("*.go linguist-generated\ngen/*.go -linguist-generated\n");
        assert!(attrs.is_set("main.go", "linguist-generated"));
        assert!(!attrs.is_set("gen/x.go", "linguist-generated"));
    }
}
