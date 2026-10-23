//! One-line skeleton per changed file, for PRs too big for one prompt: each
//! part's prompt lists the other parts' files this way, so the agent sees
//! the shape of the whole change, not only its own slice. Regex only, no
//! agent call.
//!
//! ```text
//! head file (app) ──▶ definition enclosing each changed line ─┐
//!   └ none: hunk header + context lines                       ├─▶ edits
//! changed lines ──▶ names defined on + / − lines ─────────────┴─▶ adds, removes
//!               ──▶ routes, calls `x.y(`, SQL tables, `useX(` hooks
//!
//! "api/invoice.ts (new, +40 -0): adds billInvoice; routes POST /invoices; calls db.insert"
//! ```
//!
//! Best effort across TS/JS, Python, Rust, Go, PHP, Swift and C#: a missed
//! name only makes a line shorter. Every list is capped, and so is the line.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::LazyLock;

use regex::Regex;
use theodore_domain::{FileDiff, FileStatus, Hunk, LineKind};

use crate::graph::{is_prose, names, symbols};

/// Hard cap on one file's line, in characters.
pub(crate) const LINE_MAX_CHARS: usize = 180;
const MAX_NAMES: usize = 5;
const MAX_ROUTES: usize = 3;
const MAX_CALLS: usize = 4;
const MAX_TABLES: usize = 4;
const MAX_HOOKS: usize = 3;
/// Longer lines are minified or data, not code worth reading.
const SOURCE_LINE_MAX: usize = 400;
/// Head files bigger than this fall back to the hunk headers.
const HEAD_MAX_BYTES: usize = 512 * 1024;

/// What one file's change touches.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Skeleton {
    /// Names defined only on added lines.
    pub adds: Vec<String>,
    /// Definitions the change sits inside (`Class.method`), or whose
    /// defining line changed on both sides.
    pub edits: Vec<String>,
    /// Names defined only on deleted lines.
    pub removes: Vec<String>,
    /// `GET /invoices/:id`, or just the path when the verb is unknown.
    pub routes: Vec<String>,
    /// `receiver.method`, most frequent first.
    pub calls: Vec<String>,
    pub tables: Vec<String>,
    pub hooks: Vec<String>,
}

impl Skeleton {
    pub fn is_empty(&self) -> bool {
        self.adds.is_empty()
            && self.edits.is_empty()
            && self.removes.is_empty()
            && self.routes.is_empty()
            && self.calls.is_empty()
            && self.tables.is_empty()
            && self.hooks.is_empty()
    }
}

/// Insertion-ordered set.
#[derive(Default)]
struct Ordered {
    items: Vec<String>,
    seen: BTreeSet<String>,
}

impl Ordered {
    fn push(&mut self, s: impl Into<String>) {
        let s = s.into();
        if self.seen.insert(s.clone()) {
            self.items.push(s);
        }
    }
    fn contains(&self, s: &str) -> bool {
        self.seen.contains(s)
    }
}

fn ext(path: &str) -> String {
    let base = path.rsplit('/').next().unwrap_or(path);
    base.rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default()
}

fn is_js(path: &str) -> bool {
    matches!(
        ext(path).as_str(),
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "mts" | "cts" | "vue" | "svelte"
    )
}

/// Extract `file`'s skeleton. `head` is the file's content at the PR head,
/// when the app has it: it pins down which definition each change sits in
/// beyond what the hunk header shows.
pub fn extract(file: &FileDiff, head: Option<&str>) -> Skeleton {
    let code = names::is_code(&file.path);
    let prose = is_prose(&file.path);
    let sql_file = ext(&file.path) == "sql";
    let js = is_js(&file.path);
    let swift = ext(&file.path) == "swift";
    let keyword_only = keyword_defs_only(&file.path);

    let mut added = Ordered::default();
    let mut removed = Ordered::default();
    let mut routes = Ordered::default();
    let mut tables = Ordered::default();
    let mut hooks = Ordered::default();
    // call → (count, first seen)
    let mut calls: BTreeMap<String, (usize, usize)> = BTreeMap::new();
    let mut seen = 0usize;

    for h in &file.hunks {
        for l in &h.lines {
            if l.kind == LineKind::Ctx || l.text.len() > SOURCE_LINE_MAX {
                continue;
            }
            let text = l.text.as_str();
            if prose {
                continue;
            }
            if is_comment(text) {
                continue;
            }
            let import = is_import(text);
            // Outside code (`.env`, YAML, JSON) only config keys count:
            // `"type": "array"` defines nothing.
            let defs = def_names(text, keyword_only, false)
                .into_iter()
                .filter(|d| !import && (code || is_config_key(d)));
            for d in defs {
                if l.kind == LineKind::Add {
                    added.push(d);
                } else {
                    removed.push(d);
                }
            }
            for r in routes_in(text, swift) {
                routes.push(r);
            }
            for t in tables_in(text, sql_file) {
                tables.push(t);
            }
            if js {
                for c in HOOK.captures_iter(text) {
                    hooks.push(&c[1]);
                }
            }
            if code && !import {
                for c in calls_in(text) {
                    seen += 1;
                    calls.entry(c).or_insert((0, seen)).0 += 1;
                }
            }
        }
    }

    let enclosing = match head.filter(|h| h.len() <= HEAD_MAX_BYTES) {
        _ if !code => vec![],
        Some(head) => enclosing_from_head(head, &file.hunks, keyword_only),
        None => enclosing_from_hunks(&file.hunks, keyword_only),
    };

    let mut sk = Skeleton::default();
    let mut edits = Ordered::default();
    for a in &added.items {
        if removed.contains(a) {
            edits.push(a.clone());
        } else {
            sk.adds.push(a.clone());
        }
    }
    sk.removes = removed
        .items
        .iter()
        .filter(|r| !added.contains(r))
        .cloned()
        .collect();
    for e in enclosing {
        // `Invoice.bill` when `bill` is already listed as added/removed.
        let leaf = e.rsplit('.').next().unwrap_or(&e);
        if !added.contains(leaf) && !removed.contains(leaf) {
            edits.push(e);
        }
    }
    sk.edits = edits.items;
    sk.routes = routes.items;
    sk.tables = tables.items;
    sk.hooks = hooks
        .items
        .into_iter()
        .filter(|h| !added.contains(h))
        .collect();
    let mut ranked: Vec<(String, (usize, usize))> = calls.into_iter().collect();
    ranked.sort_by(|(a, (an, af)), (b, (bn, bf))| {
        is_self_call(a)
            .cmp(&is_self_call(b))
            .then(plain_method(a).cmp(&plain_method(b)))
            .then(bn.cmp(an))
            .then(af.cmp(bf))
    });
    sk.calls = ranked.into_iter().map(|(c, _)| c).collect();
    sk
}

/// `path (new, +40 -0): adds a, b; edits C.m; routes GET /x; calls db.q; sql t; hooks useX`,
/// at most `max_chars` long (a cut list ends in `…`).
pub fn render(file: &FileDiff, sk: &Skeleton, max_chars: usize) -> String {
    let (plus, minus) =
        file.hunks
            .iter()
            .flat_map(|h| &h.lines)
            .fold((0usize, 0usize), |(p, m), l| match l.kind {
                LineKind::Add => (p + 1, m),
                LineKind::Del => (p, m + 1),
                LineKind::Ctx => (p, m),
            });
    let status = match (&file.status, &file.old_path) {
        (FileStatus::Added, _) => "new, ".to_string(),
        (FileStatus::Deleted, _) => "deleted, ".to_string(),
        (_, Some(old)) if old != &file.path => format!("from {old}, "),
        _ => String::new(),
    };
    let mut out = format!("{} ({status}+{plus} -{minus})", file.path);
    let sections: [(&str, &[String], usize); 7] = [
        ("adds", &sk.adds, MAX_NAMES),
        ("edits", &sk.edits, MAX_NAMES),
        ("removes", &sk.removes, MAX_NAMES),
        ("routes", &sk.routes, MAX_ROUTES),
        ("calls", &sk.calls, MAX_CALLS),
        ("sql", &sk.tables, MAX_TABLES),
        ("hooks", &sk.hooks, MAX_HOOKS),
    ];
    let mut first = true;
    'sections: for (label, items, cap) in sections {
        if items.is_empty() {
            continue;
        }
        let lead = if first { ": " } else { "; " };
        if out.len() + lead.len() + label.len() + 1 + items[0].len() > max_chars {
            push_ellipsis(&mut out, max_chars);
            break;
        }
        first = false;
        out.push_str(lead);
        out.push_str(label);
        out.push(' ');
        for (i, item) in items.iter().take(cap).enumerate() {
            let sep = if i == 0 { "" } else { ", " };
            if out.len() + sep.len() + item.len() > max_chars {
                push_ellipsis(&mut out, max_chars);
                break 'sections;
            }
            out.push_str(sep);
            out.push_str(item);
        }
        if items.len() > cap {
            let more = format!(" +{}", items.len() - cap);
            if out.len() + more.len() <= max_chars {
                out.push_str(&more);
            }
        }
    }
    if out.len() > max_chars {
        // Only the path itself can get here.
        let mut cut = max_chars.saturating_sub('…'.len_utf8());
        while cut > 0 && !out.is_char_boundary(cut) {
            cut -= 1;
        }
        out.truncate(cut);
        out.push('…');
    }
    out
}

fn push_ellipsis(out: &mut String, max_chars: usize) {
    if out.len() + " …".len() <= max_chars {
        out.push_str(" …");
    }
}

// ---- definitions -----------------------------------------------------

/// C#/Java/Swift-style method with a return type before its name, which
/// the graph's keyword-based definitions miss: `public async Task<Foo> Bar(`.
static TYPED_METHOD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^\s*(?:\[[^\]]*\]\s*)*(?:(?:public|private|protected|internal|static|async|override|virtual|abstract|sealed|final|extern|partial|unsafe|new)\s+)+[\w<>\[\],.?]+(?:\s*<[^>]*>)?\s+([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*\(",
    )
    .unwrap()
});
/// Containers that the graph doesn't count as definitions but that name
/// where a change sits: `impl Foo for Bar`, `extension Foo`.
static CONTAINER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^\s*(?:(?:pub(?:\([^)]*\))?|public|private|internal|fileprivate|unsafe)\s+)*(?:impl(?:\s*<[^>]*>)?\s+(?:[\w:]+(?:<[^>]*>)?\s+for\s+)?|extension\s+)([A-Za-z_][\w:]*)",
    )
    .unwrap()
});

/// Keywords and literals that a definition regex can land on.
const NOT_NAMES: &[&str] = &[
    "self",
    "Self",
    "this",
    "true",
    "false",
    "null",
    "nil",
    "None",
    "return",
    "async",
    "await",
    "const",
    "function",
    "class",
    "import",
    "export",
    "from",
    "default",
    "new",
    "void",
    "where",
    // Type words a `const char* x` or `static int` lands on.
    "char",
    "int",
    "long",
    "short",
    "unsigned",
    "signed",
    "float",
    "double",
    "bool",
    "boolean",
    "auto",
    "std",
    "string",
    "String",
    "size_t",
    "thread_local",
    "constexpr",
    "inline",
    "volatile",
    "mutable",
    "typename",
    "template",
    "operator",
    "extern",
    "number",
    "any",
    "unknown",
    "never",
    "uint8_t",
    "uint16_t",
    "uint32_t",
    "uint64_t",
    "int8_t",
    "int16_t",
    "int32_t",
    "int64_t",
    "usize",
    "isize",
    "u8",
    "u16",
    "u32",
    "u64",
    "i8",
    "i16",
    "i32",
    "i64",
    "f32",
    "f64",
];

/// `DATABASE_URL`, `VITE_PRODUCT_TAGLINE`.
fn is_config_key(n: &str) -> bool {
    n.contains('_')
        && n.chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
}

fn is_name(n: &str) -> bool {
    n.len() >= 2 && !NOT_NAMES.contains(&n) && !n.chars().all(|c| c.is_ascii_digit() || c == '_')
}

/// Words that open a definition in languages where every definition has
/// one.
const DEF_WORDS: &[&str] = &[
    "func",
    "fn",
    "def",
    "function",
    "class",
    "struct",
    "enum",
    "protocol",
    "interface",
    "trait",
    "type",
    "typealias",
    "mod",
    "module",
    "object",
    "fun",
    "let",
    "var",
    "val",
    "const",
    "static",
    "record",
    "union",
    "macro_rules",
    "defmodule",
    "defp",
];

/// Languages where every definition starts with a keyword (`func`, `def`,
/// `fn`, `function`): a bare `Name(…) {` there is a call with a trailing
/// closure (SwiftUI's `VStack {`, `Button(…) {`), not a method.
fn keyword_defs_only(path: &str) -> bool {
    matches!(
        ext(path).as_str(),
        "swift" | "kt" | "kts" | "py" | "pyi" | "go" | "rs" | "php" | "rb" | "ex" | "exs" | "scala"
    )
}

/// Names a code line defines (first one is the primary name).
/// `containers` also counts `impl Foo` / `extension Foo`, which name where
/// a change sits but define nothing new.
fn def_names(line: &str, keyword_only: bool, containers: bool) -> Vec<String> {
    let mut out = Vec::new();
    if containers && let Some(c) = CONTAINER.captures(line) {
        out.push(c[1].rsplit("::").next().unwrap_or(&c[1]).to_string());
    }
    if CONTAINER.is_match(line)
        || (keyword_only && !symbols::identifiers(line).any(|t| DEF_WORDS.contains(&t)))
    {
        return out;
    }
    if let Some(c) = TYPED_METHOD.captures(line)
        && is_name(&c[1])
    {
        out.push(c[1].to_string());
    }
    for d in symbols::definitions_where(line, is_name) {
        if !out.contains(&d) {
            out.push(d);
        }
    }
    out
}

/// A comment line; attributes (`#[get("/x")]`, `#[Route]`) are code.
fn is_comment(line: &str) -> bool {
    symbols::is_comment(line) && !line.trim_start().starts_with("#[")
}

fn indent(line: &str) -> usize {
    line.chars()
        .take_while(|c| c.is_whitespace())
        .map(|c| if c == '\t' { 4 } else { 1 })
        .sum()
}

/// For each changed position in `lines`, the definition it sits in: the
/// nearest line above (or the line itself) that defines a name and is
/// indented less, qualified by its own container (`Class.method`).
fn enclosing(lines: &[&str], changed: &[usize], keyword_only: bool) -> Vec<String> {
    // (line index, indent, name)
    let defs: Vec<(usize, usize, String)> = lines
        .iter()
        .enumerate()
        .filter(|(_, l)| l.len() <= SOURCE_LINE_MAX && !is_comment(l) && !is_import(l))
        .filter_map(|(i, l)| {
            def_names(l, keyword_only, true)
                .into_iter()
                .next()
                .map(|n| (i, indent(l), n))
        })
        .collect();
    let mut out = Ordered::default();
    for &pos in changed {
        let Some(line) = lines.get(pos) else { continue };
        if line.trim().is_empty() {
            continue;
        }
        let ind = indent(line);
        let upto = defs.partition_point(|d| d.0 <= pos);
        let Some(k) = defs[..upto].iter().rposition(|d| d.0 == pos || d.1 < ind) else {
            continue;
        };
        let (_, d_ind, name) = &defs[k];
        let container = defs[..k].iter().rev().find(|d| d.1 < *d_ind);
        match container {
            Some((_, _, c)) if c != name => out.push(format!("{c}.{name}")),
            _ => out.push(name.clone()),
        }
    }
    out.items
}

/// Changed positions as 0-based head-file line indices: each added line,
/// and for a pure deletion the line now standing where it was.
fn changed_head_lines(hunks: &[Hunk]) -> Vec<usize> {
    let mut out = Vec::new();
    for h in hunks {
        let mut pending_del = false;
        let mut any = false;
        for l in &h.lines {
            match l.kind {
                LineKind::Add => {
                    if let Some(n) = l.new_no {
                        out.push(n.saturating_sub(1) as usize);
                        any = true;
                    }
                    pending_del = false;
                }
                LineKind::Del => pending_del = true,
                LineKind::Ctx => {
                    if pending_del && let Some(n) = l.new_no {
                        out.push(n.saturating_sub(1) as usize);
                        any = true;
                    }
                    pending_del = false;
                }
            }
        }
        if !any && h.new_start > 0 {
            out.push(h.new_start as usize - 1);
        }
    }
    out.sort_unstable();
    out.dedup();
    out
}

fn enclosing_from_head(head: &str, hunks: &[Hunk], keyword_only: bool) -> Vec<String> {
    let lines: Vec<&str> = head.lines().collect();
    enclosing(&lines, &changed_head_lines(hunks), keyword_only)
}

/// Without the head file: each hunk's new side, with git's function
/// context (the hunk header) as an unindented first line.
fn enclosing_from_hunks(hunks: &[Hunk], keyword_only: bool) -> Vec<String> {
    let mut out = Ordered::default();
    for h in hunks {
        let mut lines: Vec<&str> = vec![h.header.trim()];
        let mut changed: Vec<usize> = Vec::new();
        let mut pending_del = false;
        for l in &h.lines {
            match l.kind {
                LineKind::Del => pending_del = true,
                LineKind::Add | LineKind::Ctx => {
                    lines.push(&l.text);
                    if l.kind == LineKind::Add || pending_del {
                        changed.push(lines.len() - 1);
                    }
                    pending_del = false;
                }
            }
        }
        if pending_del {
            changed.push(lines.len() - 1);
        }
        for e in enclosing(&lines, &changed, keyword_only) {
            out.push(e);
        }
    }
    out.items
}

// ---- routes ----------------------------------------------------------

/// `router.get('/x'`, `app.MapPost("/x"`, `Route::get('/x'`,
/// `r.HandleFunc("/x"`, `.route("/x", get(h))`, `@app.route('/x')`.
static ROUTE_CALL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?:\.|::|->)\s*(get|post|put|patch|delete|del|all|options|head|any|use|route|api_route|handle|handlefunc|Handle|HandleFunc|GET|POST|PUT|PATCH|DELETE|Get|Post|Put|Patch|Delete|Any|MapGet|MapPost|MapPut|MapPatch|MapDelete|Map|Group|group)\s*\(\s*['"`](/[^'"`\s]*)['"`]"#,
    )
    .unwrap()
});
/// Swift (Vapor): `app.get("users", ":id")`, path segments without a slash.
static SWIFT_ROUTE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"\.(get|post|put|patch|delete)\s*\(\s*"([^"]+)"((?:\s*,\s*"[^"]+")*)"#).unwrap()
});
/// `[HttpGet("x")]`, `[Route("api/x")]`, `#[get("/x")]`, `#[Route('/x')]`,
/// `@GetMapping("/x")`.
static ROUTE_ATTR: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?:\[|#\[|@)\s*(HttpGet|HttpPost|HttpPut|HttpPatch|HttpDelete|Route|get|post|put|patch|delete|GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping|RequestMapping)\s*\(\s*(?:path\s*=\s*|value\s*=\s*)?['"]([^'"]*)['"]"#,
    )
    .unwrap()
});
/// Django `path('users/<int:id>/', …)`.
static DJANGO_PATH: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"^\s*(?:re_)?path\(\s*r?['"]([^'"]*)['"]"#).unwrap());

fn verb(word: &str) -> Option<&'static str> {
    let w = word.to_ascii_lowercase();
    let w = w
        .trim_start_matches("http")
        .trim_start_matches("map")
        .trim_end_matches("mapping");
    match w {
        "get" => Some("GET"),
        "post" => Some("POST"),
        "put" => Some("PUT"),
        "patch" => Some("PATCH"),
        "delete" | "del" => Some("DELETE"),
        _ => None,
    }
}

fn route_label(word: &str, path: &str) -> String {
    match verb(word) {
        Some(v) => format!("{v} {path}"),
        None => path.to_string(),
    }
}

fn routes_in(line: &str, swift: bool) -> Vec<String> {
    let mut out = Vec::new();
    for c in ROUTE_CALL.captures_iter(line) {
        out.push(route_label(&c[1], &c[2]));
    }
    for c in ROUTE_ATTR.captures_iter(line) {
        out.push(route_label(&c[1], &c[2]));
    }
    if let Some(c) = DJANGO_PATH.captures(line) {
        out.push(format!("/{}", c[1].trim_start_matches(['^', '/'])));
    }
    if swift && out.is_empty() {
        for c in SWIFT_ROUTE.captures_iter(line) {
            let mut path = format!("/{}", &c[2]);
            for seg in c[3].split(',').map(|s| s.trim().trim_matches('"')) {
                if !seg.is_empty() {
                    path.push('/');
                    path.push_str(seg);
                }
            }
            out.push(route_label(&c[1], &path));
        }
    }
    out
}

// ---- calls -----------------------------------------------------------

static CALL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"([A-Za-z_$][\w$]*)\s*(?:\?\.|\.|->|::)\s*([A-Za-z_]\w*)\s*(?:<[^<>()]*>)?\s*\(")
        .unwrap()
});

/// Receivers whose calls say nothing about the change.
const NOISE_RECEIVERS: &[&str] = &[
    "console",
    "JSON",
    "Object",
    "Math",
    "Array",
    "Promise",
    "Number",
    "String",
    "Date",
    "Symbol",
    "Reflect",
    "fmt",
    "log",
    "logger",
    "assert",
    "expect",
    "std",
    "Ok",
    "Err",
    "Some",
    "Box",
    "Arc",
    "Rc",
    "Vec",
    "Self",
    "self_",
    "os",
    "sys",
    "strings",
    "strconv",
    "errors",
    "print",
    "Debug",
    "Console",
    "Task",
    "Mock",
    "mock",
    "jest",
    "vi",
    "sinon",
    "t",
    "it",
    "describe",
    "test",
    "XCTAssert",
    "Assert",
    "Optional",
    "Collections",
    "Arrays",
    "List",
    "Map",
    "Set",
    "HashMap",
    "HashSet",
    "BTreeMap",
    "BTreeSet",
    "Duration",
    "Instant",
    "Path",
    "PathBuf",
    "format",
    "parent",
    "super",
];

/// Methods too generic to describe a change.
const NOISE_METHODS: &[&str] = &[
    "new",
    "unwrap",
    "expect",
    "clone",
    "to_string",
    "to_owned",
    "into",
    "iter",
    "into_iter",
    "map",
    "filter",
    "collect",
    "push",
    "len",
    "is_empty",
    "as_str",
    "as_ref",
    "toString",
    "then",
    "catch",
    "finally",
    "forEach",
    "join",
    "split",
    "trim",
    "includes",
    "log",
    "debug",
    "info",
    "warn",
    "error",
    "format",
    "default",
    "get",
    "set",
    "append",
    "add",
    "remove",
    "contains",
    "keys",
    "values",
    "items",
    "length",
    "count",
    "first",
    "last",
    "unwrap_or",
    "ok",
    "err",
    "map_err",
    "and_then",
    "Println",
    "Printf",
    "Sprintf",
    "Errorf",
    "equal",
    "toBe",
    "toEqual",
    "assertEqual",
    "assertTrue",
    "init",
    "lower",
    "upper",
    "strip",
    "replace",
    "startsWith",
    "endsWith",
    "starts_with",
    "ends_with",
    "parse",
    "from",
    "of",
    "slice",
    "concat",
    "reduce",
    "find",
    "some",
    "every",
    "sort",
    "reverse",
    "pop",
    "shift",
    "extend",
    "entry",
    "or_default",
    "or_insert",
    "unwrap_or_default",
    "unwrap_or_else",
    "await",
    // SwiftUI / Foundation modifiers.
    "opacity",
    "padding",
    "frame",
    "font",
    "foregroundStyle",
    "foregroundColor",
    "background",
    "overlay",
    "cornerRadius",
    "offset",
    "animation",
    "onTapGesture",
    "ignoresSafeArea",
    "lowercased",
    "uppercased",
    "enumerated",
    "joined",
    "trimmingCharacters",
    "appending",
];

/// `x.save` says less than `x.saveDraft`: compound method names first.
fn plain_method(c: &str) -> bool {
    !symbols::is_compound(c.rsplit('.').next().unwrap_or(c))
}

fn is_self_call(c: &str) -> bool {
    c.starts_with("this.") || c.starts_with("self.") || c.starts_with("$this.")
}

fn is_import(line: &str) -> bool {
    let t = line.trim_start();
    [
        "import ",
        "use ",
        "from ",
        "#include",
        "#import",
        "require ",
        "using ",
        "package ",
        "export {",
        "export *",
        "export type {",
    ]
    .iter()
    .any(|p| t.starts_with(p))
}

fn calls_in(line: &str) -> Vec<String> {
    CALL.captures_iter(line)
        .filter_map(|c| {
            let recv = c[1].trim_start_matches('$');
            let method = &c[2];
            if recv.is_empty()
                || NOISE_RECEIVERS.contains(&recv)
                || NOISE_METHODS.contains(&method)
                || recv.chars().all(|ch| ch.is_ascii_digit())
            {
                return None;
            }
            let recv = if recv == "this" && c[1].starts_with('$') {
                "$this"
            } else {
                recv
            };
            Some(format!("{recv}.{method}"))
        })
        .collect()
}

// ---- SQL tables ------------------------------------------------------

/// A line that is SQL, not prose or a Python `from x import y`.
static SQL_CONTEXT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?i)\b(?:select\s|insert\s+into\s|update\s+[\w`"\[\].]+\s+set\b|delete\s+from\s|(?:create|alter|drop|truncate)\s+table\s|join\s+[`"\[]?[a-z_])"#,
    )
    .unwrap()
});
/// A continuation line of a multi-line query: `FROM users u`.
static SQL_LEAD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"^\s*['"`]?\s*(?:FROM|JOIN|INNER JOIN|LEFT JOIN|RIGHT JOIN|LEFT OUTER JOIN|INTO|UPDATE)\s+"#,
    )
    .unwrap()
});
static SQL_TABLE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?i)\b(?:from|into|update|join|table(?:\s+if\s+(?:not\s+)?exists)?)\s+[`"\[]?([a-z_][\w]*(?:\.[a-z_]\w*)?)"#,
    )
    .unwrap()
});
/// Query builders: `DB::table('users')`, `->table('x')`, `.from('x')`,
/// `knex('x')`, `Schema::create('x'`.
static ORM_TABLE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?:DB::table|Schema::(?:create|table|drop|dropIfExists)|->table|\.from|\.into|\bknex)\s*\(\s*['"]([A-Za-z_]\w*)['"]"#,
    )
    .unwrap()
});

const SQL_NOISE: &[&str] = &[
    "select", "where", "set", "values", "if", "not", "exists", "only", "lateral", "as", "on",
    "the", "a", "an", "and", "or", "dual", "unnest", "with", "table", "into", "from", "this",
    "that", "here", "there", "your", "our", "my", "its", "their", "each", "all", "any", "it",
    "them", "which", "what",
];

fn tables_in(line: &str, sql_file: bool) -> Vec<String> {
    let mut out = Vec::new();
    if sql_file || SQL_CONTEXT.is_match(line) || SQL_LEAD.is_match(line) {
        for c in SQL_TABLE.captures_iter(line) {
            let t = &c[1];
            if !SQL_NOISE.contains(&t.to_ascii_lowercase().as_str()) {
                out.push(t.to_string());
            }
        }
    }
    for c in ORM_TABLE.captures_iter(line) {
        out.push(c[1].to_string());
    }
    out
}

// ---- hooks -----------------------------------------------------------

static HOOK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\b(use[A-Z][A-Za-z0-9]*)\s*(?:<[^<>()]*>)?\s*\(").unwrap());

// ---- prompt section --------------------------------------------------

/// One other part of the PR, as listed in a part's prompt.
pub(crate) struct Part {
    pub label: String,
    /// `(skeleton line, relevance to the prompt's own part)`, file order.
    pub files: Vec<(String, f64)>,
}

/// Bytes kept back per part for its header and its "+N more" line.
const PART_OVERHEAD: usize = 200;
const SECTION_INTRO: &str = "\n# The rest of this PR\n\
This prompt covers one part of the PR. The files below belong to the other \
parts, which are grouped separately: do not put them in your groups. They are \
listed so you see the whole change. One line per file: names it adds, edits or \
removes, routes, calls, SQL tables, React hooks.\n";

/// The "rest of this PR" section for part `this` of `parts`, at most
/// `max_chars` long. When everything doesn't fit, the files most related
/// to this part are kept and the rest are counted.
pub(crate) fn section(this: usize, parts: &[Part], max_chars: usize) -> String {
    let others: Vec<usize> = (0..parts.len()).filter(|&p| p != this).collect();
    if others.is_empty() {
        return String::new();
    }
    let reserved = SECTION_INTRO.len() + PART_OVERHEAD * others.len();
    if reserved >= max_chars {
        return String::new();
    }
    let mut room = max_chars - reserved;
    // (relevance, part, position)
    let mut order: Vec<(f64, usize, usize)> = others
        .iter()
        .flat_map(|&p| {
            parts[p]
                .files
                .iter()
                .enumerate()
                .map(move |(i, (_, r))| (*r, p, i))
        })
        .collect();
    order.sort_by(|a, b| b.0.total_cmp(&a.0).then((a.1, a.2).cmp(&(b.1, b.2))));
    let mut keep: BTreeSet<(usize, usize)> = BTreeSet::new();
    for (_, p, i) in order {
        let need = parts[p].files[i].0.len() + 3;
        if need <= room {
            room -= need;
            keep.insert((p, i));
        }
    }
    let mut out = String::from(SECTION_INTRO);
    let total = parts.len();
    for &p in &others {
        let part = &parts[p];
        out.push_str(&format!(
            "\n## Part {} of {total} ({}): {} file(s)\n",
            p + 1,
            part.label,
            part.files.len()
        ));
        let mut hidden: Vec<&str> = Vec::new();
        for (i, (line, _)) in part.files.iter().enumerate() {
            if keep.contains(&(p, i)) {
                out.push_str("- ");
                out.push_str(line);
                out.push('\n');
            } else {
                hidden.push(line);
            }
        }
        if !hidden.is_empty() {
            out.push_str(&more_line(&hidden));
            out.push('\n');
        }
    }
    out
}

/// `- … +19 more file(s) in Blank/Screens (8), tools/codegen (5), +3 dirs`:
/// the files left out, counted by folder, within `PART_OVERHEAD`.
fn more_line(lines: &[&str]) -> String {
    let mut by_dir: BTreeMap<&str, usize> = BTreeMap::new();
    for l in lines {
        let path = l.split(" (").next().unwrap_or(l);
        let dir = path.rsplit_once('/').map_or("(root)", |(d, _)| d);
        *by_dir.entry(dir).or_default() += 1;
    }
    let mut dirs: Vec<(&str, usize)> = by_dir.into_iter().collect();
    dirs.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
    let mut out = format!("- … +{} more file(s) in ", lines.len());
    let mut shown = 0;
    for (d, n) in &dirs {
        let item = format!("{}{d} ({n})", if shown == 0 { "" } else { ", " });
        if out.len() + item.len() > PART_OVERHEAD - 40 {
            break;
        }
        out.push_str(&item);
        shown += 1;
    }
    if shown < dirs.len() {
        let sep = if shown == 0 { "" } else { ", " };
        out.push_str(&format!("{sep}+{} dirs", dirs.len() - shown));
    }
    out
}

#[cfg(test)]
mod tests;
