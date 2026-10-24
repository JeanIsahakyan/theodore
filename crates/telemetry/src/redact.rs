//! The one redaction step every record goes through before any sink
//! (docs/telemetry.md "Redaction"):
//!
//! ```text
//! record ─▶ local(): secrets, emails, ~, deny-listed fields, truncation ─┬─▶ file, stderr
//!                                                                         └─▶ remote(): repo/user
//!                                                                             fields + paths hashed
//!                                                                             ─▶ OTLP, PostHog
//! ```

use std::borrow::Cow;
use std::sync::LazyLock;

use regex::{Captures, Regex};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::record::Record;

/// Longest string field kept whole; longer ones are cut with a marker.
pub const MAX_FIELD_LEN: usize = 2048;
/// Stacks and backtraces get more room.
pub const MAX_STACK_LEN: usize = 8192;
pub const MAX_MESSAGE_LEN: usize = 4096;

pub const REDACTED: &str = "[redacted]";

/// Field names whose value is a credential, whatever it looks like.
const SECRET_NAMES: &[&str] = &[
    "code_verifier",
    "access_token",
    "refresh_token",
    "id_token",
    "api_key",
    "apikey",
    "client_secret",
    "private_key",
    "set_cookie",
    "password",
    "passwd",
    "secret",
    "token",
    "authorization",
    "cookie",
    "credential",
    "credentials",
];
/// A field is a credential when any `.`/`_`/`-` segment of its name is one
/// of these (`host.token`, `github_token`, `auth_cookie`).
const SECRET_SEGMENTS: &[&str] = &[
    "token",
    "secret",
    "password",
    "passwd",
    "authorization",
    "cookie",
    "credential",
    "credentials",
    "verifier",
    "apikey",
];
/// Field names that carry code or user text: never logged, only their size
/// (numbers and booleans under these names — counts — are kept).
const CONTENT_NAMES: &[&str] = &[
    "diff",
    "hunk",
    "hunks",
    "patch",
    "body",
    "comment",
    "comments",
    "content",
    "contents",
    "file_content",
    "file_contents",
    "prompt",
    "markdown",
    "snippet",
    "blob",
    "title",
    "description",
    "reply",
    "suggestion",
    "stdout",
    "transcript",
    "text",
];
/// Fields that name a repository, a person or a place on disk: kept in the
/// local file, hashed for remote sinks.
const IDENTIFYING_NAMES: &[&str] = &[
    "repo",
    "repository",
    "owner",
    "project",
    "pr",
    "pr_id",
    "branch",
    "slug",
    "worktree",
    "path",
    "file",
    "cwd",
    "dir",
    "url",
    "remote",
    "login",
    "user",
    "user_id",
    "account",
    "account_id",
    "author",
    "email",
    "space",
];
/// Longer limits for these.
const STACK_NAMES: &[&str] = &["backtrace", "stack", "component_stack"];

fn last_segment(name: &str) -> &str {
    name.rsplit(['.', '/']).next().unwrap_or(name)
}

/// Whether a field named `name` holds a credential.
pub fn is_secret_name(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    if SECRET_NAMES.contains(&n.as_str()) || SECRET_NAMES.contains(&last_segment(&n)) {
        return true;
    }
    n.split(['.', '_', '-'])
        .any(|seg| SECRET_SEGMENTS.contains(&seg))
}

/// Whether a field named `name` holds code or user text.
pub fn is_content_name(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    CONTENT_NAMES.contains(&n.as_str()) || CONTENT_NAMES.contains(&last_segment(&n))
}

fn is_identifying_name(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    IDENTIFYING_NAMES.contains(&n.as_str()) || IDENTIFYING_NAMES.contains(&last_segment(&n))
}

fn max_len_for(name: &str) -> usize {
    if STACK_NAMES.contains(&last_segment(&name.to_ascii_lowercase())) {
        MAX_STACK_LEN
    } else {
        MAX_FIELD_LEN
    }
}

/// `(pattern, replacement)`, applied in order to every string.
static SECRET_PATTERNS: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
    let p = |re: &str, with: &'static str| (Regex::new(re).expect("valid redaction regex"), with);
    vec![
        p(
            r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----",
            "[redacted:private-key]",
        ),
        // `https://user:app-password@bitbucket.org/…`, `x-access-token:…@`.
        p(
            r"(?i)\b([a-z][a-z0-9+.-]*://)[^/\s:@]+:[^/\s@]+@",
            "${1}[redacted]@",
        ),
        // `Authorization: …`, `"cookie": "…"`, `Private-Token=…`.
        p(
            r#"(?i)\b(proxy-authorization|authorization|set-cookie|cookie|x-api-key|api-key|private-token|x-auth-token)("?\s*[:=]\s*"?)[^"\r\n]*"#,
            "${1}${2}[redacted]",
        ),
        p(
            r"(?i)\b(bearer|basic)\s+[A-Za-z0-9\-._~+/]{8,}=*",
            "${1} [redacted]",
        ),
        p(
            r"\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})",
            "[redacted:github]",
        ),
        p(
            r"\bgl(?:pat|oas|rt|dt|ptt|cbt|ft|imt|agent)-[A-Za-z0-9_\-]{16,}",
            "[redacted:gitlab]",
        ),
        p(
            r"\b(?:ATBB|ATATT|ATCTT)[A-Za-z0-9_\-=]{16,}",
            "[redacted:atlassian]",
        ),
        p(r"\bsk_(?:live_|test_)?[A-Za-z0-9_]{16,}", "[redacted:key]"),
        p(
            r"\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}",
            "[redacted:jwt]",
        ),
        // OAuth and signed-URL query parameters.
        p(
            r#"(?i)([?&;](?:code|state|access_token|refresh_token|id_token|token|client_secret|code_verifier|password|api_key|apikey|key|sig|signature|auth)=)[^&\s#"'<>]+"#,
            "${1}[redacted]",
        ),
        // `token=…`, `"client_secret": "…"`, `password: …` in free text.
        p(
            r#"(?i)("?\b[a-z0-9_]*(?:token|secret|password|passwd|api_?key|code_verifier)"?\s*[:=]\s*"?)[^\s"',;&}]+"#,
            "${1}[redacted]",
        ),
    ]
});

static EMAIL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b([A-Za-z0-9._%+-]+)@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})\b")
        .expect("valid email regex")
});

/// `github.com/owner/name` (and `:owner/name` in an ssh remote).
static HOST_REPO: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)\b((?:github|gitlab|bitbucket)\.(?:com|org)[/:])([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)",
    )
    .expect("valid host repo regex")
});

static URL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"\b[a-zA-Z][a-zA-Z0-9+.-]*://[^\s"'<>]+"#).expect("valid url regex")
});

/// An absolute or `~` path of two or more segments.
static PATH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:~|\B)(?:/[A-Za-z0-9._@%+\-]+){2,}").expect("valid path regex")
});

/// Where our own source lives in a backtrace path: kept from here on.
const SOURCE_MARKERS: &[&str] = &["/crates/", "/apps/", "/.cargo/registry/", "/rustc/"];

#[derive(Debug, Clone)]
pub struct Redactor {
    /// The home directory, written as `~`.
    home: Option<String>,
    /// Salts every hash: the install id, so a hash can't be reversed by
    /// hashing well-known repository names.
    salt: String,
}

impl Redactor {
    pub fn new(home: Option<std::path::PathBuf>, salt: impl Into<String>) -> Self {
        let home = home
            .map(|h| h.to_string_lossy().trim_end_matches('/').to_string())
            .filter(|h| h.len() > 1);
        Self {
            home,
            salt: salt.into(),
        }
    }

    /// A stable short hash of `s` (10 hex chars), salted per install.
    pub fn hash(&self, s: &str) -> String {
        let mut h = Sha256::new();
        h.update(self.salt.as_bytes());
        h.update([0]);
        h.update(s.as_bytes());
        hex::encode(&h.finalize()[..5])
    }

    /// Secrets, emails and the home directory in free text.
    pub fn text(&self, s: &str) -> String {
        let mut out: Cow<str> = Cow::Borrowed(s);
        for (re, with) in SECRET_PATTERNS.iter() {
            if re.is_match(&out) {
                out = Cow::Owned(re.replace_all(&out, *with).into_owned());
            }
        }
        if EMAIL.is_match(&out) {
            out = Cow::Owned(
                EMAIL
                    .replace_all(&out, |c: &Captures| {
                        // `git@github.com:owner/name` is a remote, not a person.
                        if &c[1] == "git" {
                            c[0].to_string()
                        } else {
                            format!("<email:{}>", self.hash(&c[0].to_ascii_lowercase()))
                        }
                    })
                    .into_owned(),
            );
        }
        if let Some(home) = &self.home {
            out = Cow::Owned(replace_home(&out, home));
        }
        out.into_owned()
    }

    /// The local step (file, stderr, and the base for remote): free text
    /// cleaned, credential fields replaced, content fields reduced to their
    /// size, long values truncated.
    pub fn local(&self, r: &mut Record) {
        r.message = truncate(&self.text(&r.message), MAX_MESSAGE_LEN, false);
        let fields = std::mem::take(&mut r.fields);
        r.fields = fields
            .into_iter()
            .map(|(k, v)| {
                let v = self.local_value(&k, v);
                (k, v)
            })
            .collect();
    }

    fn local_value(&self, name: &str, v: Value) -> Value {
        if is_secret_name(name) && !matches!(v, Value::Null | Value::Bool(_)) {
            return Value::String(REDACTED.into());
        }
        if is_content_name(name) && !matches!(v, Value::Null | Value::Bool(_) | Value::Number(_)) {
            let bytes = v
                .as_str()
                .map(str::len)
                .unwrap_or_else(|| v.to_string().len());
            return Value::String(format!("[omitted: {bytes} bytes]"));
        }
        match v {
            Value::String(s) => {
                // A stderr tail or backtrace is most useful at its end.
                let keep_tail = name == "tail" || name.ends_with("_tail");
                Value::String(truncate(&self.text(&s), max_len_for(name), keep_tail))
            }
            Value::Array(a) => {
                Value::Array(a.into_iter().map(|x| self.local_value(name, x)).collect())
            }
            Value::Object(o) => Value::Object(
                o.into_iter()
                    .map(|(k, x)| {
                        let x = self.local_value(&k, x);
                        (k, x)
                    })
                    .collect::<Map<_, _>>(),
            ),
            other => other,
        }
    }

    /// The remote step, on top of `local`: repository, person and path
    /// fields hashed; repository URLs and paths in free text hashed.
    pub fn remote(&self, r: &Record) -> Record {
        let mut out = r.clone();
        out.message = self.remote_text(&out.message);
        out.fields = r
            .fields
            .iter()
            .map(|(k, v)| (k.clone(), self.remote_value(k, v)))
            .collect();
        out
    }

    fn remote_value(&self, name: &str, v: &Value) -> Value {
        match v {
            Value::String(s) if is_identifying_name(name) => {
                Value::String(format!("h:{}", self.hash(s)))
            }
            Value::String(s) => Value::String(self.remote_text(s)),
            Value::Array(a) => Value::Array(a.iter().map(|x| self.remote_value(name, x)).collect()),
            Value::Object(o) => Value::Object(
                o.iter()
                    .map(|(k, x)| (k.clone(), self.remote_value(k, x)))
                    .collect(),
            ),
            other => other.clone(),
        }
    }

    /// Repository names, URL paths and paths on disk in free text, hashed:
    /// a URL keeps its scheme and host, an ssh remote its host.
    pub fn remote_text(&self, s: &str) -> String {
        let mut out = String::with_capacity(s.len());
        let mut last = 0;
        for m in URL.find_iter(s) {
            out.push_str(&self.remote_plain(&s[last..m.start()]));
            out.push_str(&self.remote_url(m.as_str()));
            last = m.end();
        }
        out.push_str(&self.remote_plain(&s[last..]));
        out
    }

    fn remote_url(&self, u: &str) -> String {
        let after_scheme = u.find("://").map(|i| i + 3).unwrap_or(0);
        match u[after_scheme..].find(['/', '?', '#']) {
            Some(i) => {
                let (origin, rest) = u.split_at(after_scheme + i);
                format!("{origin}/<url:{}>", &self.hash(rest)[..6])
            }
            None => u.to_string(),
        }
    }

    fn remote_plain(&self, s: &str) -> String {
        let s = HOST_REPO.replace_all(s, |c: &Captures| {
            let slug = format!("{}/{}", &c[2], &c[3]);
            format!("{}h:{}", &c[1], self.hash(&slug))
        });
        PATH.replace_all(&s, |c: &Captures| {
            let p = &c[0];
            match SOURCE_MARKERS.iter().find_map(|m| p.find(m)) {
                // Our own code (a backtrace frame): the crate-relative part.
                Some(i) => format!("…{}", &p[i..]),
                None => format!("<path:{}>", &self.hash(p)[..6]),
            }
        })
        .into_owned()
    }
}

fn replace_home(s: &str, home: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find(home) {
        let after = &rest[i + home.len()..];
        // Only the whole directory: `/Users/jo` must not eat `/Users/jody`.
        let boundary = after
            .chars()
            .next()
            .is_none_or(|c| !(c.is_alphanumeric() || c == '.' || c == '_' || c == '-'));
        out.push_str(&rest[..i]);
        out.push_str(if boundary { "~" } else { home });
        rest = after;
    }
    out.push_str(rest);
    out
}

/// Cuts `s` to about `max` bytes on a char boundary, with a marker saying
/// how much went. `keep_tail` keeps the end instead of the start.
pub fn truncate(s: &str, max: usize, keep_tail: bool) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let cut = s.len() - max;
    if keep_tail {
        let mut i = cut;
        while !s.is_char_boundary(i) {
            i += 1;
        }
        format!("[truncated {i} bytes]…{}", &s[i..])
    } else {
        let mut i = max;
        while !s.is_char_boundary(i) {
            i -= 1;
        }
        format!("{}…[truncated {} bytes]", &s[..i], s.len() - i)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    use tracing::Level;

    fn r() -> Redactor {
        Redactor::new(Some("/Users/jo".into()), "install-1")
    }

    #[test]
    fn host_tokens_are_redacted() {
        let r = r();
        for (input, want) in [
            (
                "token ghp_abcdefghijklmnopqrstuvwxyz0123456789 rejected",
                "token [redacted:github] rejected",
            ),
            ("gho_ABCDEFGHIJKLMNOPQRSTUV", "[redacted:github]"),
            ("ghs_0123456789abcdefABCDEF", "[redacted:github]"),
            (
                "github_pat_11ABCDEFG0123456789_abcdefghijklmnop",
                "[redacted:github]",
            ),
            ("glpat-abcdefghij0123456789", "[redacted:gitlab]"),
            ("ATBB0123456789abcdefghijKLMN", "[redacted:atlassian]"),
        ] {
            assert_eq!(r.text(input), want, "{input}");
        }
    }

    #[test]
    fn app_passwords_in_urls_are_redacted() {
        assert_eq!(
            r().text("fatal: https://jo:s3cretAppPass@bitbucket.org/acme/app.git failed"),
            "fatal: https://[redacted]@bitbucket.org/acme/app.git failed"
        );
        assert_eq!(
            r().text("https://x-access-token:ghs_whatever@github.com/a/b"),
            "https://[redacted]@github.com/a/b"
        );
    }

    #[test]
    fn bearer_workos_keys_and_jwts_are_redacted() {
        let r = r();
        assert_eq!(
            r.text("sent Bearer abc.DEF-123_456~+/xyz=="),
            "sent Bearer [redacted]"
        );
        assert_eq!(
            r.text("key sk_test_a1B2c3D4e5F6g7H8i9J0"),
            "key [redacted:key]"
        );
        assert_eq!(
            r.text("jwt eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyXzEifQ.c2lnbmF0dXJl end"),
            "jwt [redacted:jwt] end"
        );
    }

    #[test]
    fn authorization_headers_are_redacted() {
        let r = r();
        assert_eq!(
            r.text("Authorization: token abcdef"),
            "Authorization: [redacted]"
        );
        assert_eq!(
            r.text(r#"{"authorization":"Basic Zm9vOmJhcg==","x":1}"#),
            r#"{"authorization":"[redacted]","x":1}"#
        );
        assert_eq!(
            r.text("Cookie: session=abc; other=def"),
            "Cookie: [redacted]"
        );
    }

    #[test]
    fn oauth_query_parameters_are_redacted() {
        assert_eq!(
            r().text("GET http://127.0.0.1:47823/callback?code=01HXYZ&state=abc123 200"),
            "GET http://127.0.0.1:47823/callback?code=[redacted]&state=[redacted] 200"
        );
        assert_eq!(
            r().text("theodore://callback?state=s1&code=c2#x"),
            "theodore://callback?state=[redacted]&code=[redacted]#x"
        );
    }

    #[test]
    fn key_value_secrets_in_text_are_redacted() {
        let r = r();
        assert_eq!(
            r.text(r#"{"refresh_token": "abc", "client_secret":"def"}"#),
            r#"{"refresh_token": "[redacted]", "client_secret":"[redacted]"}"#
        );
        assert_eq!(r.text("password=hunter2 next"), "password=[redacted] next");
        // Prose about tokens stays readable.
        assert_eq!(
            r.text("not authenticated or token rejected"),
            "not authenticated or token rejected"
        );
        assert_eq!(r.text("input_tokens: 1200"), "input_tokens: 1200");
    }

    #[test]
    fn emails_are_hashed_and_git_remotes_kept() {
        let r = r();
        let out = r.text("signed in as Jo.Doe@Example.com");
        assert!(out.starts_with("signed in as <email:"), "{out}");
        assert!(!out.contains("Example"));
        // Stable and case-insensitive.
        assert_eq!(out, r.text("signed in as jo.doe@example.com"));
        assert_eq!(
            r.text("git@github.com:acme/app.git"),
            "git@github.com:acme/app.git"
        );
    }

    #[test]
    fn the_home_directory_becomes_a_tilde() {
        let r = r();
        assert_eq!(
            r.text("opened /Users/jo/.theodore/theodore.db"),
            "opened ~/.theodore/theodore.db"
        );
        assert_eq!(r.text("/Users/jo"), "~");
        assert_eq!(r.text("/Users/jody/x"), "/Users/jody/x");
    }

    #[test]
    fn credential_fields_are_replaced_whatever_they_hold() {
        for name in [
            "token",
            "host.token",
            "github_token",
            "Authorization",
            "cookie",
            "code_verifier",
            "client_secret",
            "password",
        ] {
            assert!(is_secret_name(name), "{name}");
        }
        for name in ["error.code", "tokens", "input_tokens", "agent", "op_id"] {
            assert!(!is_secret_name(name), "{name}");
        }
        let mut rec = Record::new(Level::INFO, "t", "m")
            .with_field("token", "plain-looking")
            .with_field("authorization", "x");
        r().local(&mut rec);
        assert_eq!(rec.fields["token"], REDACTED);
        assert_eq!(rec.fields["authorization"], REDACTED);
    }

    #[test]
    fn content_fields_keep_only_their_size_and_counts_survive() {
        let mut rec = Record::new(Level::INFO, "t", "m")
            .with_field("diff", "@@ -1 +1 @@\n-a\n+b")
            .with_field("comment.body", "looks good")
            .with_field("title", "Secret project")
            .with_field("hunks", 12)
            .with_field("comments", 3);
        r().local(&mut rec);
        assert_eq!(rec.fields["diff"], "[omitted: 17 bytes]");
        assert_eq!(rec.fields["comment.body"], "[omitted: 10 bytes]");
        assert_eq!(rec.fields["title"], "[omitted: 14 bytes]");
        assert_eq!(rec.fields["hunks"], 12);
        assert_eq!(rec.fields["comments"], 3);
    }

    #[test]
    fn long_values_are_truncated_with_a_marker() {
        let long = "x".repeat(MAX_FIELD_LEN + 100);
        let mut rec = Record::new(Level::WARN, "t", "y".repeat(MAX_MESSAGE_LEN + 1))
            .with_field("detail", long.clone())
            .with_field("stderr_tail", format!("{long}END"))
            .with_field("backtrace", long.clone());
        r().local(&mut rec);
        let detail = rec.fields["detail"].as_str().unwrap();
        assert!(detail.ends_with("…[truncated 100 bytes]"), "{detail}");
        let tail = rec.fields["stderr_tail"].as_str().unwrap();
        assert!(tail.starts_with("[truncated 103 bytes]…"), "{tail}");
        assert!(tail.ends_with("END"));
        // Backtraces get the longer limit.
        assert_eq!(rec.fields["backtrace"].as_str().unwrap(), long);
        assert!(rec.message.ends_with("…[truncated 1 bytes]"));
        // Multi-byte text is cut on a char boundary.
        assert_eq!(truncate("ééé", 3, false), "é…[truncated 4 bytes]");
    }

    #[test]
    fn remote_hashes_repositories_people_and_paths_but_the_file_keeps_them() {
        let r = r();
        let mut rec = Record::new(
            Level::WARN,
            "t",
            "fetch https://github.com/acme/app failed in /Users/jo/.theodore/worktrees/acme/app",
        )
        .with_field("repo", "acme/app")
        .with_field("pr", "github:acme/app#12")
        .with_field("login", "jo")
        .with_field("attempt", 2)
        .with_field(
            "backtrace",
            "at /Users/jo/src/theodore/crates/app/src/core.rs:12:5",
        );
        r.local(&mut rec);
        assert_eq!(rec.fields["repo"], "acme/app");
        let remote = r.remote(&rec);
        let h = r.hash("acme/app");
        assert_eq!(remote.fields["repo"], format!("h:{h}"));
        assert_ne!(remote.fields["pr"], rec.fields["pr"]);
        assert!(remote.fields["login"].as_str().unwrap().starts_with("h:"));
        assert_eq!(remote.fields["attempt"], 2);
        assert!(!remote.message.contains("acme"), "{}", remote.message);
        assert!(remote.message.starts_with("fetch https://github.com/<url:"));
        assert!(remote.message.contains("<path:"));
        assert_eq!(
            r.remote_text("remote git@github.com:acme/app.git"),
            format!("remote git@github.com:h:{}", r.hash("acme/app.git"))
        );
        assert_eq!(
            remote.fields["backtrace"],
            "at …/crates/app/src/core.rs:12:5"
        );
        // Salted per install: another install hashes differently.
        assert_ne!(Redactor::new(None, "install-2").hash("acme/app"), h);
    }
}
