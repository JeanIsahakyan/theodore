//! `interdiff` (plan §4, "Re-review"): what changed in a hunk between the
//! head the reviewer last looked at and the PR's current head, both diffed
//! against the same PR base so hunk ids and new-side ranges line up.

use theodore_contract::{
    InterdiffClass, InterdiffEntry, InterdiffRequest, InterdiffWordSpan, RevisionRequest,
};
use theodore_domain::interdiff::{HunkChange, classify, vanished, word_diff};
use theodore_domain::{Hunk, HunkId, Revision};

use crate::core::Core;
use crate::error::AppResult;

impl Core {
    pub async fn interdiff(&self, req: InterdiffRequest) -> AppResult<Vec<InterdiffEntry>> {
        self.ensure_open(&req.pr).await?;
        let head = self.load_pr_detail(&req.pr).await?.summary.head_sha;

        let old = self
            .get_revision(RevisionRequest {
                pr: req.pr.clone(),
                head: req.base_sha.clone(),
            })
            .await?;
        let new = self
            .get_revision(RevisionRequest {
                pr: req.pr.clone(),
                head,
            })
            .await?;

        let changes = classify(&old, &new);
        let gone = vanished(&old, &changes);

        let mut out = Vec::new();
        for file in &new.files {
            if req.file.as_deref().is_some_and(|f| f != file.path) {
                continue;
            }
            for h in &file.hunks {
                let (class, previous, words) = match changes.get(&h.id) {
                    Some(HunkChange::Unchanged) | None => (InterdiffClass::Unchanged, None, vec![]),
                    Some(HunkChange::New) => (InterdiffClass::New, None, vec![]),
                    Some(HunkChange::Changed { previous }) => {
                        let words = find_hunk(&old, previous)
                            .map(|o| wire_words(word_diff(o, h)))
                            .unwrap_or_default();
                        (InterdiffClass::Changed, Some(previous.clone()), words)
                    }
                };
                out.push(InterdiffEntry {
                    hunk: h.id.clone(),
                    path: file.path.clone(),
                    class,
                    previous,
                    words,
                });
            }
        }
        for file in &old.files {
            if req.file.as_deref().is_some_and(|f| f != file.path) {
                continue;
            }
            for h in &file.hunks {
                if gone.contains(&h.id) {
                    out.push(InterdiffEntry {
                        hunk: h.id.clone(),
                        path: file.path.clone(),
                        class: InterdiffClass::Vanished,
                        previous: None,
                        words: vec![],
                    });
                }
            }
        }
        Ok(out)
    }
}

fn find_hunk<'a>(rev: &'a Revision, id: &HunkId) -> Option<&'a Hunk> {
    rev.hunks().find(|h| &h.id == id)
}

fn wire_words(words: Vec<theodore_domain::interdiff::WordSpan>) -> Vec<InterdiffWordSpan> {
    words
        .into_iter()
        .map(|w| InterdiffWordSpan {
            kind: w.kind,
            text: w.text,
        })
        .collect()
}
