//! Import edges: which changed file references which other changed file,
//! read from import/require/use/include lines. Best-effort and per
//! language; anything that doesn't resolve to another changed file is
//! dropped (a package import says nothing about the PR's own structure).

use std::collections::{BTreeMap, BTreeSet};
use std::sync::LazyLock;

use regex::Regex;

/// Changed-file lookup by exact path, by path without extension, by every
/// segment suffix (`c`, `b/c`, `a/b/c` for `a/b/c.ts`) and by directory.
pub(crate) struct PathIndex<'a> {
    files: &'a [String],
    exact: BTreeMap<&'a str, usize>,
    by_suffix: BTreeMap<String, Vec<usize>>,
    by_dir_suffix: BTreeMap<String, Vec<usize>>,
}

fn strip_ext(path: &str) -> &str {
    let slash = path.rfind('/').map_or(0, |i| i + 1);
    match path[slash..].find('.') {
        Some(0) | None => path,
        Some(dot) => &path[..slash + dot],
    }
}

fn dir_of(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(d, _)| d)
}

fn file_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn suffixes(path: &str) -> Vec<String> {
    let segs: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    (0..segs.len()).map(|i| segs[i..].join("/")).collect()
}

impl<'a> PathIndex<'a> {
    pub(crate) fn new(files: &'a [String]) -> Self {
        let mut exact = BTreeMap::new();
        let mut by_suffix: BTreeMap<String, Vec<usize>> = BTreeMap::new();
        let mut by_dir_suffix: BTreeMap<String, Vec<usize>> = BTreeMap::new();
        for (i, f) in files.iter().enumerate() {
            exact.insert(f.as_str(), i);
            for s in suffixes(strip_ext(f)) {
                by_suffix.entry(s).or_default().push(i);
            }
            for s in suffixes(dir_of(f)) {
                by_dir_suffix.entry(s).or_default().push(i);
            }
        }
        Self {
            files,
            exact,
            by_suffix,
            by_dir_suffix,
        }
    }

    fn exact(&self, p: &str) -> Option<usize> {
        self.exact.get(p).copied()
    }

    /// Files whose extension-less path ends with `segs` — longest match
    /// first, at least `min` segments, and only an unambiguous hit.
    fn suffix(&self, segs: &[&str], min: usize) -> Option<usize> {
        let segs: Vec<&str> = segs.iter().copied().filter(|s| !s.is_empty()).collect();
        for start in 0..segs.len() {
            let n = segs.len() - start;
            if n < min.max(1) {
                break;
            }
            let key = segs[start..].join("/");
            if let Some(hits) = self.by_suffix.get(&key) {
                // Several files share this tail: ambiguous, don't guess.
                return (hits.len() == 1).then(|| hits[0]);
            }
        }
        None
    }

    /// Code files directly in a directory whose path ends with `segs`.
    fn dir(&self, segs: &[&str], min: usize) -> Vec<usize> {
        let segs: Vec<&str> = segs.iter().copied().filter(|s| !s.is_empty()).collect();
        for start in 0..segs.len() {
            let n = segs.len() - start;
            if n < min.max(1) {
                break;
            }
            let key = segs[start..].join("/");
            if let Some(hits) = self.by_dir_suffix.get(&key) {
                let direct: Vec<usize> = hits
                    .iter()
                    .copied()
                    .filter(|&i| dir_of(&self.files[i]).ends_with(&key))
                    .collect();
                if !direct.is_empty() {
                    return direct;
                }
            }
        }
        vec![]
    }
}

/// `a/b/../c/./d` → `a/c/d`; `None` if it climbs above the root.
fn normalize(path: &str) -> Option<String> {
    let mut out: Vec<&str> = Vec::new();
    for seg in path.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                out.pop()?;
            }
            s => out.push(s),
        }
    }
    Some(out.join("/"))
}

fn join(dir: &str, rel: &str) -> Option<String> {
    if dir.is_empty() {
        normalize(rel)
    } else {
        normalize(&format!("{dir}/{rel}"))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Lang {
    Js,
    Py,
    Rs,
    Go,
    Php,
    Cs,
    C,
    Jvm,
    Other,
}

fn lang(path: &str) -> Lang {
    let ext = file_name(path)
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "mts" | "cts" | "vue" | "svelte" => Lang::Js,
        "py" | "pyi" => Lang::Py,
        "rs" => Lang::Rs,
        "go" => Lang::Go,
        "php" => Lang::Php,
        "cs" => Lang::Cs,
        "c" | "cc" | "cpp" | "cxx" | "h" | "hh" | "hpp" | "m" | "mm" => Lang::C,
        "java" | "kt" | "kts" | "scala" => Lang::Jvm,
        _ => Lang::Other,
    }
}

static JS_SPEC: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]"#).unwrap()
});
static PY_FROM: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*from\s+(\.*)([\w.]*)\s+import\s+(.+)$").unwrap());
static PY_IMPORT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)").unwrap());
static RS_MOD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;").unwrap());
static RS_PATH: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\b(crate|super|self)((?:::\w+)+)").unwrap());
static GO_IMPORT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"^\s*(?:import\s+)?(?:[\w.]+\s+)?"([\w.\-/]+)"\s*\)?\s*$"#).unwrap()
});
static PHP_INCLUDE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"\b(?:require|include)(?:_once)?\s*\(?\s*(__DIR__\s*\.\s*)?['"]([^'"]+)['"]"#)
        .unwrap()
});
static PHP_QUALIFIED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\\?\b([A-Za-z_]\w*(?:\\[A-Za-z_]\w*)+)").unwrap());
static CS_USING: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*(?:global\s+)?using\s+(?:static\s+)?([\w.]+)\s*;").unwrap());
static C_INCLUDE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"^\s*#\s*(?:include|import)\s*"([^"]+)""#).unwrap());
static JVM_IMPORT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*import\s+(?:static\s+)?([\w.]+)").unwrap());

const JS_EXTS: &[&str] = &[
    "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "d.ts", "vue",
];

fn resolve_js(from: &str, spec: &str, idx: &PathIndex) -> Option<usize> {
    let candidate = if spec.starts_with('.') {
        join(dir_of(from), spec)?
    } else if let Some(rest) = spec.strip_prefix("@/").or_else(|| spec.strip_prefix("~/")) {
        let segs: Vec<&str> = rest.split('/').collect();
        return idx.suffix(&segs, 1);
    } else {
        // A bare specifier: a workspace path alias resolves by its tail
        // (`@app/billing/invoice` → `…/billing/invoice.ts`), a package
        // import (`react`) never matches two segments of a changed file.
        let segs: Vec<&str> = spec.split('/').filter(|s| !s.starts_with('@')).collect();
        return idx.suffix(&segs, 2);
    };
    if let Some(i) = idx.exact(&candidate) {
        return Some(i);
    }
    let stem = strip_js_ext(&candidate);
    for ext in JS_EXTS {
        if let Some(i) = idx.exact(&format!("{stem}.{ext}")) {
            return Some(i);
        }
    }
    for ext in JS_EXTS {
        if let Some(i) = idx.exact(&format!("{candidate}/index.{ext}")) {
            return Some(i);
        }
    }
    None
}

/// ESM TypeScript imports `./a.js` for `a.ts`.
fn strip_js_ext(p: &str) -> &str {
    for e in [".js", ".jsx", ".mjs", ".cjs"] {
        if let Some(s) = p.strip_suffix(e) {
            return s;
        }
    }
    p
}

fn resolve_py(from: &str, line: &str, idx: &PathIndex, out: &mut Vec<usize>) {
    if let Some(c) = PY_FROM.captures(line) {
        let dots = c[1].len();
        let module = &c[2];
        let names: Vec<&str> = c[3]
            .trim_matches(|ch| ch == '(' || ch == ')')
            .split(',')
            .map(|n| n.split_whitespace().next().unwrap_or(""))
            .filter(|n| !n.is_empty() && *n != "*")
            .collect();
        let mod_segs: Vec<&str> = module.split('.').filter(|s| !s.is_empty()).collect();
        if dots > 0 {
            let mut base = dir_of(from).to_string();
            for _ in 1..dots {
                base = dir_of(&base).to_string();
            }
            let mut prefix = base;
            for s in &mod_segs {
                prefix = if prefix.is_empty() {
                    s.to_string()
                } else {
                    format!("{prefix}/{s}")
                };
            }
            let try_mod = |p: &str| {
                idx.exact(&format!("{p}.py"))
                    .or_else(|| idx.exact(&format!("{p}/__init__.py")))
            };
            let mut hit = false;
            for n in &names {
                let p = if prefix.is_empty() {
                    n.to_string()
                } else {
                    format!("{prefix}/{n}")
                };
                if let Some(i) = try_mod(&p) {
                    out.push(i);
                    hit = true;
                }
            }
            if !hit && let Some(i) = try_mod(&prefix) {
                out.push(i);
            }
        } else {
            let mut hit = false;
            for n in &names {
                let mut segs = mod_segs.clone();
                segs.push(n);
                if let Some(i) = idx.suffix(&segs, 2) {
                    out.push(i);
                    hit = true;
                }
            }
            if !hit {
                let mut segs = mod_segs.clone();
                if let Some(i) = idx.suffix(&segs, 2) {
                    out.push(i);
                } else {
                    segs.push("__init__");
                    if let Some(i) = idx.suffix(&segs, 2) {
                        out.push(i);
                    }
                }
            }
        }
    } else if let Some(c) = PY_IMPORT.captures(line) {
        for m in c[1].split(',') {
            let segs: Vec<&str> = m.trim().split('.').collect();
            if let Some(i) = idx.suffix(&segs, 2) {
                out.push(i);
            }
        }
    }
}

/// The directory holding a Rust file's child modules: `a/mod.rs`,
/// `a/lib.rs`, `a/main.rs` own `a/`; `a/b.rs` owns `a/b/`.
fn rust_module_dir(from: &str) -> String {
    let name = file_name(from);
    let dir = dir_of(from);
    if matches!(name, "mod.rs" | "lib.rs" | "main.rs") {
        dir.to_string()
    } else {
        let stem = name.strip_suffix(".rs").unwrap_or(name);
        if dir.is_empty() {
            stem.to_string()
        } else {
            format!("{dir}/{stem}")
        }
    }
}

fn rust_module_file(dir: &str, segs: &[&str], idx: &PathIndex) -> Option<usize> {
    for k in (1..=segs.len()).rev() {
        let p = segs[..k].join("/");
        let base = if dir.is_empty() {
            p
        } else {
            format!("{dir}/{p}")
        };
        if let Some(i) = idx
            .exact(&format!("{base}.rs"))
            .or_else(|| idx.exact(&format!("{base}/mod.rs")))
        {
            return Some(i);
        }
    }
    None
}

fn resolve_rs(from: &str, line: &str, idx: &PathIndex, out: &mut Vec<usize>) {
    if let Some(c) = RS_MOD.captures(line) {
        let dir = rust_module_dir(from);
        if let Some(i) = rust_module_file(&dir, &[&c[1]], idx) {
            out.push(i);
        }
    }
    for c in RS_PATH.captures_iter(line) {
        let segs: Vec<&str> = c[2].split("::").filter(|s| !s.is_empty()).collect();
        let base = match &c[1] {
            "crate" => match from.rfind("src/") {
                Some(i) => from[..i + 3].to_string(),
                None => continue,
            },
            "self" => rust_module_dir(from),
            _ => {
                // `super` is the parent of this file's own module.
                let own = rust_module_dir(from);
                dir_of(&own).to_string()
            }
        };
        if let Some(i) = rust_module_file(&base, &segs, idx) {
            out.push(i);
        } else if c[1] == *"crate" || c[1] == *"super" {
            // `crate::foo` where `foo` is declared in lib.rs/main.rs itself.
            for root in ["lib.rs", "main.rs", "mod.rs"] {
                let p = if base.is_empty() {
                    root.to_string()
                } else {
                    format!("{base}/{root}")
                };
                if let Some(i) = idx.exact(&p) {
                    out.push(i);
                    break;
                }
            }
        }
    }
}

fn resolve_line(from: &str, l: Lang, line: &str, idx: &PathIndex, out: &mut Vec<usize>) {
    match l {
        Lang::Js => {
            for c in JS_SPEC.captures_iter(line) {
                if let Some(i) = resolve_js(from, &c[1], idx) {
                    out.push(i);
                }
            }
        }
        Lang::Py => resolve_py(from, line, idx, out),
        Lang::Rs => resolve_rs(from, line, idx, out),
        Lang::Go => {
            if let Some(c) = GO_IMPORT.captures(line) {
                let segs: Vec<&str> = c[1].split('/').collect();
                let hits = idx.dir(&segs, 1);
                // A one-segment tail only counts if it names one directory.
                if hits.len() <= 8 {
                    out.extend(
                        hits.into_iter()
                            .filter(|&i| !idx.files[i].ends_with("_test.go")),
                    );
                }
            }
        }
        Lang::Php => {
            for c in PHP_INCLUDE.captures_iter(line) {
                let rel = c[2].trim_start_matches('/');
                let hit = join(dir_of(from), rel)
                    .and_then(|p| idx.exact(&p))
                    .or_else(|| idx.exact(rel))
                    .or_else(|| idx.suffix(&strip_ext(rel).split('/').collect::<Vec<_>>(), 2));
                if let Some(i) = hit {
                    out.push(i);
                }
            }
            for c in PHP_QUALIFIED.captures_iter(line) {
                let segs: Vec<&str> = c[1].split('\\').collect();
                if let Some(i) = idx.suffix(&segs, 2) {
                    out.push(i);
                }
            }
        }
        Lang::Cs => {
            if let Some(c) = CS_USING.captures(line) {
                let segs: Vec<&str> = c[1].split('.').collect();
                let hits = idx.dir(&segs, 2);
                if hits.len() <= 8 {
                    out.extend(hits);
                }
            }
        }
        Lang::C => {
            if let Some(c) = C_INCLUDE.captures(line) {
                let rel = &c[1];
                let hit = join(dir_of(from), rel)
                    .and_then(|p| idx.exact(&p))
                    .or_else(|| {
                        let segs: Vec<&str> = strip_ext(rel).split('/').collect();
                        idx.suffix(&segs, 1)
                    });
                if let Some(i) = hit {
                    out.push(i);
                }
            }
        }
        Lang::Jvm => {
            if let Some(c) = JVM_IMPORT.captures(line) {
                let segs: Vec<&str> = c[1].split('.').collect();
                if let Some(i) = idx.suffix(&segs, 2) {
                    out.push(i);
                }
            }
        }
        Lang::Other => {}
    }
}

/// Changed files that `files[from]` references, given every line known of
/// it (hunk lines, plus the whole head file when available).
pub(crate) fn references<'l>(
    idx: &PathIndex,
    from: usize,
    lines: impl Iterator<Item = &'l str>,
) -> BTreeSet<usize> {
    let path = &idx.files[from];
    let l = lang(path);
    if l == Lang::Other {
        return BTreeSet::new();
    }
    let mut out = Vec::new();
    for line in lines {
        if line.len() > 400 {
            continue;
        }
        resolve_line(path, l, line, idx, &mut out);
    }
    out.into_iter().filter(|&i| i != from).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn refs(files: &[&str], from: &str, lines: &[&str]) -> Vec<String> {
        let files: Vec<String> = files.iter().map(|s| s.to_string()).collect();
        let idx = PathIndex::new(&files);
        let from = files.iter().position(|f| f == from).unwrap();
        references(&idx, from, lines.iter().copied())
            .into_iter()
            .map(|i| files[i].clone())
            .collect()
    }

    #[test]
    fn typescript_relative_imports_resolve_extensions_and_index() {
        let files = [
            "src/a/main.ts",
            "src/a/client-sync.ts",
            "src/b/index.ts",
            "src/c/esm.ts",
            "src/d/view.tsx",
        ];
        let got = refs(
            &files,
            "src/a/main.ts",
            &[
                "import { sync } from './client-sync';",
                "export * from '../b';",
                "import { x } from \"../c/esm.js\";",
                "const V = require('../d/view')",
                "const lazy = () => import('./missing');",
                "import React from 'react';",
            ],
        );
        assert_eq!(
            got,
            vec![
                "src/a/client-sync.ts",
                "src/b/index.ts",
                "src/c/esm.ts",
                "src/d/view.tsx"
            ]
        );
    }

    #[test]
    fn typescript_path_alias_resolves_by_tail() {
        let files = ["ui/src/lib/api.ts", "ui/src/views/Inbox.tsx"];
        let got = refs(
            &files,
            "ui/src/views/Inbox.tsx",
            &["import { api } from '@/lib/api';"],
        );
        assert_eq!(got, vec!["ui/src/lib/api.ts"]);
    }

    #[test]
    fn python_absolute_and_relative_imports() {
        let files = [
            "django/db/models/query.py",
            "django/db/models/sql/compiler.py",
            "django/db/models/__init__.py",
            "django/db/backends/utils.py",
        ];
        let got = refs(
            &files,
            "django/db/models/query.py",
            &[
                "from .sql import compiler",
                "from django.db.backends import utils",
                "import os",
            ],
        );
        assert_eq!(
            got,
            vec![
                "django/db/models/sql/compiler.py",
                "django/db/backends/utils.py"
            ]
        );
        let got = refs(
            &files,
            "django/db/models/sql/compiler.py",
            &["from .. import query"],
        );
        assert_eq!(got, vec!["django/db/models/query.py"]);
    }

    #[test]
    fn rust_mod_and_crate_paths() {
        let files = [
            "crates/g/src/lib.rs",
            "crates/g/src/graph/mod.rs",
            "crates/g/src/graph/louvain.rs",
            "crates/g/src/prompt.rs",
        ];
        assert_eq!(
            refs(
                &files,
                "crates/g/src/lib.rs",
                &["pub mod graph;", "mod prompt;"]
            ),
            vec!["crates/g/src/graph/mod.rs", "crates/g/src/prompt.rs"]
        );
        assert_eq!(
            refs(&files, "crates/g/src/graph/mod.rs", &["mod louvain;"]),
            vec!["crates/g/src/graph/louvain.rs"]
        );
        assert_eq!(
            refs(
                &files,
                "crates/g/src/prompt.rs",
                &["use crate::graph::louvain::run;"]
            ),
            vec!["crates/g/src/graph/louvain.rs"]
        );
        assert_eq!(
            refs(
                &files,
                "crates/g/src/graph/louvain.rs",
                &["use super::Edge;", "let p = crate::prompt::x();"]
            ),
            vec!["crates/g/src/graph/mod.rs", "crates/g/src/prompt.rs"]
        );
    }

    #[test]
    fn go_imports_resolve_to_package_directory() {
        let files = [
            "svc/billing/invoice.go",
            "svc/billing/tax.go",
            "cmd/api/main.go",
            "svc/billing/tax_test.go",
        ];
        let got = refs(
            &files,
            "cmd/api/main.go",
            &["import (", "\t\"example.com/x/svc/billing\"", ")"],
        );
        assert_eq!(got, vec!["svc/billing/invoice.go", "svc/billing/tax.go"]);
    }

    #[test]
    fn php_require_use_and_qualified_names() {
        let files = [
            "al_audio.php",
            "platform.php",
            "lib/classes/Controllers/AudioController.php",
            "lib/classes/Processors/AudioProcessor.php",
        ];
        let got = refs(
            &files,
            "al_audio.php",
            &[
                "require_once 'platform.php';",
                "al_dispatch(\\VK\\Controllers\\AudioController::class);",
            ],
        );
        assert_eq!(
            got,
            vec![
                "platform.php",
                "lib/classes/Controllers/AudioController.php"
            ]
        );
        let got = refs(
            &files,
            "lib/classes/Controllers/AudioController.php",
            &["use VK\\Processors\\AudioProcessor;"],
        );
        assert_eq!(got, vec!["lib/classes/Processors/AudioProcessor.php"]);
    }

    #[test]
    fn csharp_using_and_c_include() {
        let files = [
            "src/Shop/Billing/Invoice.cs",
            "src/Shop/Api/Program.cs",
            "net/conn.h",
            "net/conn.c",
        ];
        assert_eq!(
            refs(&files, "src/Shop/Api/Program.cs", &["using Shop.Billing;"]),
            vec!["src/Shop/Billing/Invoice.cs"]
        );
        assert_eq!(
            refs(
                &files,
                "net/conn.c",
                &["#include \"conn.h\"", "#include <stdio.h>"]
            ),
            vec!["net/conn.h"]
        );
    }

    #[test]
    fn normalize_handles_dot_segments() {
        assert_eq!(normalize("a/b/../c/./d").as_deref(), Some("a/c/d"));
        assert_eq!(normalize("../x"), None);
    }
}
