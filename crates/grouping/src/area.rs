//! Shared "top-level area" helper: the first path segment of a file, the
//! fallback for files the relatedness graph links to nothing — both when
//! splitting a large PR's prompt (`prompt::build_prompts_with`) and when
//! deciding which neighbouring group a tiny group's lone hunk belongs with
//! (`coarsen::merge_tiny_groups`). Kept in one place so both agree on what
//! "same area" means.

/// Files in the repository root share one area, `""`: treating each root
/// file as its own "directory" split a PR with 33 root-level entry points
/// into 33 prompts and 33 one-hunk groups.
pub(crate) fn top_level_dir(path: &str) -> &str {
    match path.split_once('/') {
        Some((dir, _)) => dir,
        None => "",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_on_first_slash() {
        assert_eq!(top_level_dir("crates/grouping/src/lib.rs"), "crates");
        assert_eq!(top_level_dir("README.md"), "");
        assert_eq!(top_level_dir("al_audio.php"), top_level_dir("al_wall.php"));
        assert_eq!(top_level_dir(""), "");
    }
}
