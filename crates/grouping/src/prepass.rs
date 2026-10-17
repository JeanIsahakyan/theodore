//! Deterministic pre-pass (plan §5.1).
//!
//! `hidden` files bypass the agent entirely: their hunks never appear in a
//! prompt, they are collapsed straight into a `Hidden` group. `skim`
//! candidates are hints only — mechanical-looking hunks flagged in the
//! prompt so the agent can mark them `skim` without re-deriving the pattern,
//! but the agent has the final say.

use std::collections::BTreeMap;

use theodore_domain::{FileDiff, FileFlag, FileStatus, Hunk, HunkId, LineKind, Revision};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HiddenReason {
    /// `FileFlag::Generated { reason }`.
    Generated(String),
    Lockfile,
    Vendored,
    Snapshot,
}

impl HiddenReason {
    pub fn label(&self) -> &str {
        match self {
            HiddenReason::Generated(_) => "generated",
            HiddenReason::Lockfile => "lockfile",
            HiddenReason::Vendored => "vendored",
            HiddenReason::Snapshot => "snapshot",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkimCandidate {
    /// The whole file was renamed; its remaining hunks are usually reference
    /// updates, not new behavior.
    PureRename,
    /// Added lines and deleted lines are the same once trimmed.
    WhitespaceOnly,
    /// Every changed line matches the language's import/use statement shape.
    ImportOnly,
}

impl SkimCandidate {
    pub fn label(&self) -> &'static str {
        match self {
            SkimCandidate::PureRename => "pure rename",
            SkimCandidate::WhitespaceOnly => "whitespace-only",
            SkimCandidate::ImportOnly => "import-only",
        }
    }
}

#[derive(Debug, Default, Clone)]
pub struct PrePass {
    /// path → why it is hidden.
    pub hidden: BTreeMap<String, HiddenReason>,
    /// hunk id → skim hint.
    pub skim: BTreeMap<HunkId, SkimCandidate>,
}

impl PrePass {
    pub fn is_hidden(&self, path: &str) -> bool {
        self.hidden.contains_key(path)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Lang {
    Ts,
    Rs,
    Py,
    Go,
    Other,
}

impl Lang {
    fn detect(path: &str) -> Lang {
        match path.rsplit('.').next().unwrap_or("") {
            "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" => Lang::Ts,
            "rs" => Lang::Rs,
            "py" => Lang::Py,
            "go" => Lang::Go,
            _ => Lang::Other,
        }
    }
}

const LOCKFILE_NAMES: &[&str] = &[
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "cargo.lock",
    "poetry.lock",
    "go.sum",
    "composer.lock",
    "gemfile.lock",
    "pipfile.lock",
    "pdm.lock",
    "bun.lockb",
    "uv.lock",
];

const VENDORED_DIRS: &[&str] = &[
    "vendor/",
    "node_modules/",
    "third_party/",
    "thirdparty/",
    "pods/",
];

fn hidden_reason(file: &FileDiff) -> Option<HiddenReason> {
    for flag in &file.flags {
        if let FileFlag::Generated { reason } = flag {
            return Some(HiddenReason::Generated(reason.clone()));
        }
    }
    let lower = file.path.to_ascii_lowercase();
    let base = lower.rsplit('/').next().unwrap_or(&lower);
    if LOCKFILE_NAMES.contains(&base) {
        return Some(HiddenReason::Lockfile);
    }
    if VENDORED_DIRS.iter().any(|d| lower.contains(d)) {
        return Some(HiddenReason::Vendored);
    }
    if lower.contains("__snapshots__/") || base.ends_with(".snap") || base.ends_with(".snapshot") {
        return Some(HiddenReason::Snapshot);
    }
    None
}

fn changed_lines(hunk: &Hunk) -> (Vec<&str>, Vec<&str>) {
    let mut add = Vec::new();
    let mut del = Vec::new();
    for l in &hunk.lines {
        match l.kind {
            LineKind::Add => add.push(l.text.as_str()),
            LineKind::Del => del.push(l.text.as_str()),
            LineKind::Ctx => {}
        }
    }
    (add, del)
}

fn is_import_line(line: &str, lang: Lang) -> bool {
    let t = line.trim();
    if t.is_empty() {
        return true;
    }
    match lang {
        Lang::Ts => {
            t.starts_with("import ")
                || t.starts_with("export * from")
                || (t.starts_with("export {") && t.contains("from"))
                || t.ends_with("';")
                || t.ends_with("\";")
                || t == "}"
        }
        Lang::Rs => t.starts_with("use ") || t.starts_with("pub use "),
        Lang::Py => t.starts_with("import ") || t.starts_with("from "),
        Lang::Go => {
            t == "import ("
                || t == ")"
                || t.starts_with("import ")
                || (t.starts_with('"') && t.ends_with('"'))
        }
        Lang::Other => false,
    }
}

fn skim_candidate(hunk: &Hunk, lang: Lang) -> Option<SkimCandidate> {
    let (add, del) = changed_lines(hunk);
    if add.is_empty() && del.is_empty() {
        return None;
    }
    let mut ta: Vec<String> = add.iter().map(|s| s.trim().to_string()).collect();
    let mut td: Vec<String> = del.iter().map(|s| s.trim().to_string()).collect();
    ta.sort_unstable();
    td.sort_unstable();
    if !ta.is_empty() && ta == td {
        return Some(SkimCandidate::WhitespaceOnly);
    }
    if lang != Lang::Other
        && add
            .iter()
            .chain(del.iter())
            .all(|l| is_import_line(l, lang))
    {
        return Some(SkimCandidate::ImportOnly);
    }
    None
}

/// Run the pre-pass over a revision.
pub fn run(rev: &Revision) -> PrePass {
    let mut hidden = BTreeMap::new();
    let mut skim = BTreeMap::new();
    for file in &rev.files {
        if let Some(reason) = hidden_reason(file) {
            hidden.insert(file.path.clone(), reason);
            continue;
        }
        if file.status == FileStatus::Renamed {
            for hunk in &file.hunks {
                skim.insert(hunk.id.clone(), SkimCandidate::PureRename);
            }
            continue;
        }
        let lang = Lang::detect(&file.path);
        for hunk in &file.hunks {
            if let Some(c) = skim_candidate(hunk, lang) {
                skim.insert(hunk.id.clone(), c);
            }
        }
    }
    PrePass { hidden, skim }
}

#[cfg(test)]
mod tests {
    use super::*;
    use theodore_domain::{DiffLine, FileDiff, FileStatus, Hunk, HunkId, LineKind, Revision, Sha};

    fn line(kind: LineKind, text: &str) -> DiffLine {
        DiffLine {
            kind,
            text: text.into(),
            old_no: None,
            new_no: None,
        }
    }

    fn hunk(id: &str, lines: Vec<DiffLine>) -> Hunk {
        Hunk {
            id: HunkId::new(id),
            path: String::new(),
            old_start: 1,
            old_lines: 1,
            new_start: 1,
            new_lines: 1,
            header: String::new(),
            lines,
        }
    }

    fn file(
        path: &str,
        status: FileStatus,
        flags: Vec<theodore_domain::FileFlag>,
        hunks: Vec<Hunk>,
    ) -> FileDiff {
        FileDiff {
            path: path.into(),
            old_path: None,
            status,
            similarity: None,
            old_mode: None,
            new_mode: None,
            flags,
            additions: 0,
            deletions: 0,
            hunks,
        }
    }

    fn rev(files: Vec<FileDiff>) -> Revision {
        Revision {
            base: Sha::new("base"),
            head: Sha::new("head"),
            files,
        }
    }

    #[test]
    fn hides_lockfiles_and_generated() {
        let r = rev(vec![
            file(
                "pnpm-lock.yaml",
                FileStatus::Modified,
                vec![],
                vec![hunk("h1", vec![line(LineKind::Add, "x")])],
            ),
            file(
                "src/generated/x.ts",
                FileStatus::Added,
                vec![theodore_domain::FileFlag::Generated {
                    reason: "codegen".into(),
                }],
                vec![hunk("h2", vec![line(LineKind::Add, "y")])],
            ),
            file(
                "src/real.ts",
                FileStatus::Modified,
                vec![],
                vec![hunk("h3", vec![line(LineKind::Add, "z")])],
            ),
        ]);
        let p = run(&r);
        assert!(p.is_hidden("pnpm-lock.yaml"));
        assert!(p.is_hidden("src/generated/x.ts"));
        assert!(!p.is_hidden("src/real.ts"));
        assert!(p.skim.is_empty());
    }

    #[test]
    fn flags_whitespace_only_hunk() {
        let r = rev(vec![file(
            "src/a.ts",
            FileStatus::Modified,
            vec![],
            vec![hunk(
                "h1",
                vec![
                    line(LineKind::Del, "  const x = 1;"),
                    line(LineKind::Add, "const x = 1;"),
                ],
            )],
        )]);
        let p = run(&r);
        assert_eq!(
            p.skim.get(&HunkId::new("h1")),
            Some(&SkimCandidate::WhitespaceOnly)
        );
    }

    #[test]
    fn flags_import_only_hunk() {
        let r = rev(vec![file(
            "src/a.ts",
            FileStatus::Modified,
            vec![],
            vec![hunk(
                "h1",
                vec![
                    line(LineKind::Add, "import { x } from './x';"),
                    line(LineKind::Add, "import { y } from './y';"),
                ],
            )],
        )]);
        let p = run(&r);
        assert_eq!(
            p.skim.get(&HunkId::new("h1")),
            Some(&SkimCandidate::ImportOnly)
        );
    }

    #[test]
    fn flags_rust_use_only_hunk() {
        let r = rev(vec![file(
            "src/a.rs",
            FileStatus::Modified,
            vec![],
            vec![hunk(
                "h1",
                vec![line(LineKind::Add, "use crate::foo::Bar;")],
            )],
        )]);
        let p = run(&r);
        assert_eq!(
            p.skim.get(&HunkId::new("h1")),
            Some(&SkimCandidate::ImportOnly)
        );
    }

    #[test]
    fn renamed_file_hunks_are_pure_rename_candidates() {
        let r = rev(vec![file(
            "src/b.ts",
            FileStatus::Renamed,
            vec![],
            vec![hunk(
                "h1",
                vec![
                    line(LineKind::Del, "export function old() {}"),
                    line(LineKind::Add, "export function neu() {}"),
                ],
            )],
        )]);
        let p = run(&r);
        assert_eq!(
            p.skim.get(&HunkId::new("h1")),
            Some(&SkimCandidate::PureRename)
        );
    }

    #[test]
    fn normal_behavioral_hunk_is_not_flagged() {
        let r = rev(vec![file(
            "src/a.ts",
            FileStatus::Modified,
            vec![],
            vec![hunk(
                "h1",
                vec![line(LineKind::Add, "if (used >= limit) throw new Error();")],
            )],
        )]);
        let p = run(&r);
        assert!(!p.skim.contains_key(&HunkId::new("h1")));
    }
}
