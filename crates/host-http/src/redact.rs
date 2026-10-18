//! Token redaction. Applied to anything derived from a response body or a
//! `reqwest::Error`'s `Display` before it reaches a log line or a
//! `HostError` — both can end up in UI toasts or crash reports.

pub(crate) fn redact(token: Option<&str>, text: &str) -> String {
    match token {
        Some(t) if !t.is_empty() && text.contains(t) => text.replace(t, "<redacted>"),
        _ => text.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_token_occurrences() {
        let out = redact(
            Some("ghp_secret"),
            "Bad credentials for ghp_secret in header",
        );
        assert_eq!(out, "Bad credentials for <redacted> in header");
    }

    #[test]
    fn leaves_text_untouched_without_token() {
        assert_eq!(redact(None, "plain message"), "plain message");
        assert_eq!(redact(Some(""), "plain message"), "plain message");
    }
}
