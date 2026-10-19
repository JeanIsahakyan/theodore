//! PR chain ("stack") detection (plan "Stack"): within one repo, a PR whose
//! `head_ref` is another PR's `base_ref` is that PR's parent. Pure function
//! over the `PrSummary` rows the caller already has — no I/O, no host call.

use std::collections::HashMap;

use crate::model::{PrId, PrSummary, StackInfo};

/// Computes `StackInfo` for every PR in `prs` that has a parent or a child
/// in the batch. `head_ref`/`base_ref` names are only unique within one
/// repo, so matches are scoped to `(host, owner, name)`; PRs from different
/// repos never link even if the branch names coincide. A PR with neither a
/// parent nor a child in `prs` is simply absent from the result (its
/// `stack` field should be cleared to `None`).
pub fn compute_stacks(prs: &[PrSummary]) -> HashMap<PrId, StackInfo> {
    let mut by_head: HashMap<(&crate::model::RepoRef, &str), &PrSummary> = HashMap::new();
    for p in prs {
        by_head.insert((&p.pr.repo, p.head_ref.as_str()), p);
    }

    let mut out = HashMap::new();
    for p in prs {
        let base_pr = by_head
            .get(&(&p.pr.repo, p.base_ref.as_str()))
            .filter(|parent| parent.pr.number != p.pr.number)
            .map(|parent| parent.pr.number as u32);

        let children: Vec<u32> = prs
            .iter()
            .filter(|c| {
                c.pr.repo == p.pr.repo && c.base_ref == p.head_ref && c.pr.number != p.pr.number
            })
            .map(|c| c.pr.number as u32)
            .collect();

        if base_pr.is_some() || !children.is_empty() {
            out.insert(p.pr.id(), StackInfo { base_pr, children });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{CheckRollup, HostKind, Person, PrRef, PrState, RepoRef, Sha};

    fn pr(repo: &str, number: u64, head: &str, base: &str) -> PrSummary {
        PrSummary {
            pr: PrRef {
                repo: RepoRef {
                    host: HostKind::Github,
                    owner: "acme".into(),
                    name: repo.into(),
                },
                number,
                host_id: None,
            },
            title: format!("pr {number}"),
            author: Person {
                login: "a".into(),
                name: None,
                avatar_url: None,
            },
            state: PrState::Open,
            base_ref: base.into(),
            head_ref: head.into(),
            head_sha: Sha::new("x"),
            additions: 0,
            deletions: 0,
            changed_files: 0,
            reasons: vec![],
            checks: CheckRollup::None,
            approvals: 0,
            required_approvals: None,
            updated_at: 0,
            url: String::new(),
            review_decision: None,
            conflicts: false,
            created_at: None,
            stack: None,
        }
    }

    #[test]
    fn builds_a_three_deep_chain() {
        let prs = vec![
            pr("api", 482, "feat/a", "main"),
            pr("api", 483, "feat/b", "feat/a"),
            pr("api", 484, "feat/c", "feat/b"),
        ];
        let stacks = compute_stacks(&prs);

        let s482 = stacks.get(&prs[0].pr.id()).expect("482 has a child");
        assert_eq!(s482.base_pr, None);
        assert_eq!(s482.children, vec![483]);

        let s483 = stacks.get(&prs[1].pr.id()).expect("483 has both");
        assert_eq!(s483.base_pr, Some(482));
        assert_eq!(s483.children, vec![484]);

        let s484 = stacks.get(&prs[2].pr.id()).expect("484 has a parent");
        assert_eq!(s484.base_pr, Some(483));
        assert_eq!(s484.children, Vec::<u32>::new());
    }

    #[test]
    fn unrelated_pr_is_absent_from_the_result() {
        let prs = vec![
            pr("api", 1, "feat/a", "main"),
            pr("api", 2, "feat/b", "main"),
        ];
        let stacks = compute_stacks(&prs);
        assert!(stacks.is_empty());
    }

    #[test]
    fn same_branch_names_in_different_repos_never_link() {
        let mut parent = pr("api", 1, "feat/a", "main");
        parent.pr.repo.name = "api".into();
        let mut child = pr("web", 2, "feat/b", "feat/a");
        child.pr.repo.name = "web".into();
        let stacks = compute_stacks(&[parent, child]);
        assert!(stacks.is_empty());
    }

    #[test]
    fn a_pr_based_on_itself_is_not_its_own_parent() {
        // Degenerate input (base_ref == head_ref); must not self-match.
        let odd = pr("api", 1, "feat/a", "feat/a");
        let stacks = compute_stacks(&[odd]);
        assert!(stacks.is_empty());
    }
}
