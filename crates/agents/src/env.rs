//! Child process environment: pass the parent env through, minus Theodore's own secrets.

/// Filter out `THEODORE_*` vars from an env var list. Pure, so the rule is testable
/// without mutating the real process env.
pub fn filtered(vars: impl IntoIterator<Item = (String, String)>) -> Vec<(String, String)> {
    vars.into_iter()
        .filter(|(k, _)| !k.starts_with("THEODORE_"))
        .collect()
}

/// Parent env minus `THEODORE_*` vars. Agents keep their own auth vars
/// (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, ...) untouched.
pub fn filtered_env() -> Vec<(String, String)> {
    filtered(std::env::vars())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_theodore_vars_only() {
        let input = vec![
            ("THEODORE_SECRET_TOKEN".to_string(), "x".to_string()),
            ("ANTHROPIC_API_KEY".to_string(), "keep-me".to_string()),
        ];
        let out = filtered(input);
        assert_eq!(
            out,
            vec![("ANTHROPIC_API_KEY".to_string(), "keep-me".to_string())]
        );
    }
}
