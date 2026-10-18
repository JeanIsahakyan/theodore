//! Shared "top-level area" helper: the first path segment of a file, used
//! both to split a large PR's prompt by directory (`prompt::build_prompts`)
//! and to decide which neighbouring group a tiny group's lone hunk belongs
//! with (`coarsen::merge_tiny_groups`). Kept in one place so both agree on
//! what "same area" means.

pub(crate) fn top_level_dir(path: &str) -> &str {
    path.split('/').next().unwrap_or(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_on_first_slash() {
        assert_eq!(top_level_dir("crates/grouping/src/lib.rs"), "crates");
        assert_eq!(top_level_dir("README.md"), "README.md");
        assert_eq!(top_level_dir(""), "");
    }
}
