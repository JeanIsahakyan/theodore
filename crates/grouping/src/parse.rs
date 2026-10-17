//! Tolerant JSON extraction from an agent's final text: fenced code blocks,
//! prose around the object, or a bare object.

/// Find and parse a JSON object in `text`, trying progressively looser
/// strategies. Returns `None` if nothing in the text parses as JSON.
pub fn extract_json(text: &str) -> Option<serde_json::Value> {
    if let Some(v) = extract_fenced(text) {
        return Some(v);
    }
    if let Some(v) = extract_balanced(text) {
        return Some(v);
    }
    serde_json::from_str(text.trim()).ok()
}

/// ```json ... ``` or plain ``` ... ``` fences, first one that parses.
fn extract_fenced(text: &str) -> Option<serde_json::Value> {
    let mut rest = text;
    while let Some(start) = rest.find("```") {
        let after_marker = &rest[start + 3..];
        // Skip an optional language tag up to the first newline.
        let body_start = after_marker.find('\n').map(|i| i + 1).unwrap_or(0);
        let body = &after_marker[body_start..];
        if let Some(end) = body.find("```") {
            let candidate = &body[..end];
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(candidate.trim()) {
                return Some(v);
            }
            rest = &body[end + 3..];
        } else {
            break;
        }
    }
    None
}

/// Scans every `{` as a possible object start and returns the first
/// balanced, parseable span (brace counting, aware of strings and escapes).
fn extract_balanced(text: &str) -> Option<serde_json::Value> {
    let bytes = text.as_bytes();
    for start in 0..bytes.len() {
        if bytes[start] != b'{' {
            continue;
        }
        if let Some(end) = matching_brace(bytes, start) {
            let candidate = &text[start..=end];
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(candidate) {
                return Some(v);
            }
        }
    }
    None
}

fn matching_brace(bytes: &[u8], start: usize) -> Option<usize> {
    let mut depth = 0i32;
    let mut in_string = false;
    let mut escaped = false;
    for (i, &b) in bytes.iter().enumerate().skip(start) {
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
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_bare_json() {
        let v = extract_json(r#"{"groups": []}"#).unwrap();
        assert_eq!(v["groups"], serde_json::json!([]));
    }

    #[test]
    fn parses_fenced_json() {
        let text = "Here you go:\n```json\n{\"groups\": [1, 2]}\n```\nhope that helps";
        let v = extract_json(text).unwrap();
        assert_eq!(v["groups"], serde_json::json!([1, 2]));
    }

    #[test]
    fn parses_plain_fence_without_language_tag() {
        let text = "```\n{\"groups\": [1]}\n```";
        let v = extract_json(text).unwrap();
        assert_eq!(v["groups"], serde_json::json!([1]));
    }

    #[test]
    fn parses_object_surrounded_by_prose() {
        let text = "Sure! Here is the grouping: {\"groups\": [{\"id\": \"a\"}]} Let me know if you want changes.";
        let v = extract_json(text).unwrap();
        assert_eq!(v["groups"][0]["id"], "a");
    }

    #[test]
    fn nested_braces_in_strings_do_not_break_scanning() {
        let text = r#"{"groups": [{"id": "a", "why": "uses {curly} in prose"}]}"#;
        let v = extract_json(text).unwrap();
        assert_eq!(v["groups"][0]["why"], "uses {curly} in prose");
    }

    #[test]
    fn returns_none_for_garbage() {
        assert!(extract_json("not json at all, sorry, I can't help with that").is_none());
    }
}
