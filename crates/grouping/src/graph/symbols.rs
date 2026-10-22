//! Identifier signals read from changed lines: names a hunk defines
//! (functions, classes, consts, methods, config keys), every identifier it
//! touches, and an "edit shape" that is the same for the same mechanical
//! edit repeated across files.

use std::sync::LazyLock;

use regex::Regex;

/// Words that introduce a definition in some language; the next identifier
/// after one (skipping modifiers) is the defined name.
const DEF_KEYWORDS: &[&str] = &[
    "function",
    "class",
    "interface",
    "type",
    "enum",
    "struct",
    "trait",
    "fn",
    "def",
    "func",
    "const",
    "let",
    "var",
    "val",
    "static",
    "protocol",
    "object",
    "record",
    "module",
    "mod",
    "union",
    "typealias",
    "fun",
    "macro_rules",
];

const MODIFIERS: &[&str] = &[
    "pub",
    "export",
    "default",
    "async",
    "mut",
    "abstract",
    "final",
    "public",
    "private",
    "protected",
    "static",
    "readonly",
    "override",
    "open",
    "internal",
    "inline",
    "unsafe",
    "declare",
    "sealed",
    "data",
    "extern",
    "case",
    "crate",
    "super",
    "in",
    "suspend",
];

/// Identifiers too common to relate two files by.
const STOP_IDENTS: &[&str] = &[
    "this",
    "self",
    "Self",
    "true",
    "false",
    "null",
    "none",
    "None",
    "nil",
    "undefined",
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
    "public",
    "private",
    "protected",
    "static",
    "void",
    "string",
    "String",
    "number",
    "boolean",
    "bool",
    "int",
    "float",
    "double",
    "char",
    "byte",
    "long",
    "short",
    "usize",
    "isize",
    "u8",
    "u16",
    "u32",
    "u64",
    "i32",
    "i64",
    "f32",
    "f64",
    "Option",
    "Result",
    "Some",
    "Vec",
    "Box",
    "Arc",
    "new",
    "else",
    "elif",
    "then",
    "while",
    "for",
    "loop",
    "match",
    "switch",
    "case",
    "break",
    "continue",
    "throw",
    "throws",
    "catch",
    "try",
    "finally",
    "struct",
    "enum",
    "impl",
    "trait",
    "type",
    "interface",
    "extends",
    "implements",
    "where",
    "with",
    "yield",
    "lambda",
    "pass",
    "raise",
    "assert",
    "print",
    "println",
    "format",
    "value",
    "values",
    "data",
    "name",
    "names",
    "item",
    "items",
    "list",
    "index",
    "key",
    "keys",
    "result",
    "results",
    "error",
    "errors",
    "err",
    "args",
    "argv",
    "options",
    "opts",
    "config",
    "props",
    "state",
    "context",
    "ctx",
    "req",
    "res",
    "request",
    "response",
    "input",
    "output",
    "test",
    "tests",
    "expect",
    "describe",
    "should",
    "assert_eq",
    "unwrap",
    "clone",
    "into",
    "from",
    "self",
    "super",
    "crate",
    "main",
    "init",
    "setup",
    "teardown",
    "handle",
    "handler",
    "render",
    "update",
    "create",
    "delete",
    "remove",
    "insert",
    "get",
    "set",
    "add",
    "run",
    "start",
    "stop",
    "call",
    "apply",
    "build",
    "make",
    "load",
    "save",
    "read",
    "write",
    "open",
    "close",
    "next",
    "prev",
    "push",
    "pop",
    "len",
    "size",
    "count",
    "length",
    "map",
    "filter",
    "reduce",
    "each",
    "some",
    "every",
    "find",
    "join",
    "split",
    "trim",
    "parse",
    "json",
    "JSON",
    "Object",
    "Array",
    "Promise",
    "Error",
    "Date",
    "Math",
    "console",
    "log",
    "debug",
    "info",
    "warn",
    "window",
    "document",
    "process",
    "module",
    "require",
    "exports",
    "object",
    "array",
    "Map",
    "Set",
    "HashMap",
    "BTreeMap",
    "HashSet",
    "BTreeSet",
    "await",
    "unsafe",
    "dyn",
    "mut",
    "ref",
    "pub",
    "use",
    "mod",
    "let",
    "var",
    "val",
    "fun",
    "func",
    "def",
    "fn",
    "nullptr",
    "NULL",
    "void",
    "elseif",
    "endif",
    "isset",
    "empty",
    "array_map",
    "echo",
    "foreach",
    "instanceof",
    "typeof",
    "keyof",
    "readonly",
    "override",
    "abstract",
    "final",
    "virtual",
    "inline",
    "extern",
    "include",
    "define",
    "ifdef",
    "ifndef",
    "pragma",
    "TODO",
    "FIXME",
    "id",
    "ids",
    "type_",
    "path",
    "file",
    "files",
    "line",
    "lines",
    "text",
    "body",
    "title",
    "description",
    "message",
    "status",
    "code",
    "user",
    "users",
    "url",
    "time",
    "date",
    "info",
    "meta",
    "Default",
    "Debug",
    "Clone",
    "PartialEq",
    "Eq",
    "Serialize",
    "Deserialize",
    "derive",
];

pub(crate) fn is_stop(ident: &str) -> bool {
    ident.len() < 4
        || STOP_IDENTS.contains(&ident)
        || ident.chars().all(|c| c.is_ascii_digit() || c == '_')
}

/// Identifiers (`[A-Za-z_$][A-Za-z0-9_$]*`) in a line, in order.
pub(crate) fn identifiers(line: &str) -> impl Iterator<Item = &str> {
    line.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '$'))
        .map(|t| t.trim_start_matches('$'))
        .filter(|t| {
            t.chars()
                .next()
                .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        })
}

/// An identifier distinctive enough to link two files when both touch it:
/// compound (`snake_case`, `camelCase`, `SCREAMING_CASE`) and not short.
pub(crate) fn is_compound(ident: &str) -> bool {
    if ident.len() < 6 || is_stop(ident) {
        return false;
    }
    let inner_underscore = ident.trim_matches('_').contains('_');
    let hump = ident
        .as_bytes()
        .windows(2)
        .any(|w| w[0].is_ascii_lowercase() && w[1].is_ascii_uppercase());
    inner_underscore || hump
}

static METHOD_DEF: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^\s*(?:(?:public|private|protected|static|async|override|final|abstract|readonly|internal|open|virtual|export|function|fun|func|def|fn|pub(?:\([^)]*\))?)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^;]*\)\s*(?::\s*[^={;]+|->\s*[^={;]+)?\s*\{\s*$",
    )
    .unwrap()
});
static GO_FUNC: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*func\b\s*(?:\([^)]*\)\s*)?([A-Za-z_]\w*)").unwrap());
static CONFIG_KEY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\s*(?:export\s+|ENV\s+|ARG\s+|-\s+)?([A-Z][A-Z0-9_]{3,})\s*[=:]").unwrap()
});

const CONTROL: &[&str] = &[
    "if",
    "for",
    "while",
    "switch",
    "catch",
    "match",
    "return",
    "function",
    "foreach",
    "elseif",
    "else",
    "do",
    "try",
    "with",
    "sizeof",
    "typeof",
    "when",
    "guard",
    "synchronized",
    "using",
    "lock",
    "fixed",
    "unless",
    "until",
];

/// Definition keywords that also declare function-local variables.
const LOCAL_KEYWORDS: &[&str] = &["let", "var", "val", "const"];

fn is_comment(line: &str) -> bool {
    let t = line.trim_start();
    t.starts_with("//")
        || t.starts_with("/*")
        || t.starts_with("* ")
        || t == "*"
        || t.starts_with("<!--")
        || t.starts_with("--")
        || (t.starts_with('#') && !t.starts_with("#define") && !t.starts_with("# define"))
}

/// A defined name distinctive enough to link many files: compound
/// (`HonkKit`, `al_dispatch`). Plain words — `State`, `Color`,
/// `validation` — are also framework or prose vocabulary and only count
/// when few files share them.
pub(crate) fn is_distinctive(name: &str) -> bool {
    is_compound(name)
}

/// Names a changed line defines: `function foo`, `class Foo`, `const FOO`,
/// `fn foo`, `def foo`, `func (r *T) Foo`, a method header `foo(a, b) {`,
/// or a config/env key `FOO_BAR=`. Comments define nothing ("a first-class
/// SECURE type" is prose, not `class SECURE`).
pub(crate) fn definitions(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    if is_comment(line) {
        return out;
    }
    let toks: Vec<&str> = identifiers(line).collect();
    // `let x = …` inside a function body is a local, not something other
    // files can use: variable keywords only define at the top level
    // (unindented) or when exported.
    let top_level = !line.starts_with([' ', '\t'])
        || toks
            .iter()
            .any(|t| matches!(*t, "export" | "pub" | "public" | "static"));
    let mut i = 0;
    while i < toks.len() {
        if DEF_KEYWORDS.contains(&toks[i]) && (top_level || !LOCAL_KEYWORDS.contains(&toks[i])) {
            let mut j = i + 1;
            while j < toks.len() && MODIFIERS.contains(&toks[j]) {
                j += 1;
            }
            if let Some(name) = toks.get(j)
                && !DEF_KEYWORDS.contains(name)
                && !is_stop(name)
            {
                out.push((*name).to_string());
            }
            i = j;
        }
        i += 1;
    }
    if let Some(c) = GO_FUNC.captures(line)
        && !is_stop(&c[1])
    {
        out.push(c[1].to_string());
    }
    if let Some(c) = METHOD_DEF.captures(line) {
        let name = c[1].trim_start_matches('$');
        if !CONTROL.contains(&name) && !is_stop(name) {
            out.push(name.to_string());
        }
    }
    if let Some(c) = CONFIG_KEY.captures(line)
        && c[1].contains('_')
    {
        out.push(c[1].to_string());
    }
    out.sort();
    out.dedup();
    out
}

/// Keywords kept as-is in an edit shape (everything else that looks like a
/// name is masked).
const SHAPE_KEEP: &[&str] = &[
    "if",
    "else",
    "for",
    "while",
    "return",
    "new",
    "class",
    "function",
    "fn",
    "def",
    "let",
    "const",
    "var",
    "use",
    "import",
    "from",
    "export",
    "public",
    "private",
    "protected",
    "static",
    "async",
    "await",
    "match",
    "self",
    "this",
    "null",
    "true",
    "false",
    "None",
    "pub",
    "mut",
    "impl",
    "struct",
    "enum",
    "type",
    "interface",
    "throw",
    "try",
    "catch",
    "require",
    "require_once",
    "include",
    "include_once",
];

/// One changed line reduced to its structure: names → `_`, strings → `S`,
/// numbers → `0`, whitespace dropped. `None` for a blank line.
fn shape_line(line: &str) -> Option<String> {
    let mut out = String::new();
    let mut chars = line.trim().chars().peekable();
    while let Some(c) = chars.next() {
        if c.is_whitespace() {
            continue;
        }
        if c == '"' || c == '\'' || c == '`' {
            for d in chars.by_ref() {
                if d == c {
                    break;
                }
            }
            out.push('S');
        } else if c.is_ascii_digit() {
            while chars
                .peek()
                .is_some_and(|d| d.is_ascii_alphanumeric() || *d == '.')
            {
                chars.next();
            }
            out.push('0');
        } else if c.is_alphabetic() || c == '_' {
            let mut word = String::from(c);
            while let Some(&d) = chars.peek() {
                if d.is_alphanumeric() || d == '_' {
                    word.push(d);
                    chars.next();
                } else {
                    break;
                }
            }
            if SHAPE_KEEP.contains(&word.as_str()) {
                out.push_str(&word);
                out.push(' ');
            } else {
                out.push('_');
            }
        } else {
            out.push(c);
        }
    }
    (!out.is_empty()).then_some(out)
}

/// The shape of a hunk's edit, or `None` when it carries no structural
/// change: formatting and pure renames shape the same on both sides, and
/// a tiny edit (a few tokens) repeats by coincidence.
pub(crate) fn edit_shape<'l>(
    added: impl Iterator<Item = &'l str>,
    deleted: impl Iterator<Item = &'l str>,
) -> Option<String> {
    let add: Vec<String> = added.filter_map(shape_line).collect();
    let del: Vec<String> = deleted.filter_map(shape_line).collect();
    let mut a_sorted = add.clone();
    let mut d_sorted = del.clone();
    a_sorted.sort();
    d_sorted.sort();
    if a_sorted == d_sorted {
        return None;
    }
    let size: usize = add.iter().chain(&del).map(|l| l.len()).sum();
    if size < 12 || add.len() + del.len() > 40 {
        return None;
    }
    let mut s = String::new();
    for l in &del {
        s.push('-');
        s.push_str(l);
        s.push('\n');
    }
    for l in &add {
        s.push('+');
        s.push_str(l);
        s.push('\n');
    }
    Some(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_definitions_across_languages() {
        assert_eq!(
            definitions("export async function syncClients(x) {"),
            vec!["syncClients"]
        );
        assert_eq!(
            definitions("export class AppClientStore {"),
            vec!["AppClientStore"]
        );
        assert_eq!(
            definitions("pub(crate) fn build_graph(rev: &Revision) -> Graph {"),
            vec!["build_graph"]
        );
        assert_eq!(
            definitions("def resolve_installation(self, org):"),
            vec!["resolve_installation"]
        );
        assert_eq!(
            definitions("func (s *Server) HandleLogin(w http.ResponseWriter) {"),
            vec!["HandleLogin"]
        );
        assert_eq!(
            definitions("function al_dispatch(string $controllerClass): void"),
            vec!["al_dispatch"]
        );
        assert_eq!(
            definitions("    private function getAudioProcessor(): AudioProcessor"),
            vec!["getAudioProcessor"]
        );
        assert_eq!(
            definitions("  async resolveGrant(orgId: string): Promise<Grant> {"),
            vec!["resolveGrant"]
        );
        assert_eq!(
            definitions("CORE_TO_AUTH_SYNC_SECRET=change-me"),
            vec!["CORE_TO_AUTH_SYNC_SECRET"]
        );
        assert_eq!(
            definitions("  - CORE_TO_AUTH_SYNC_SECRET: ${{ secrets.X }}"),
            vec!["CORE_TO_AUTH_SYNC_SECRET"]
        );
        assert_eq!(definitions("const MAX_RETRIES = 3;"), vec!["MAX_RETRIES"]);
    }

    #[test]
    fn calls_and_control_flow_are_not_definitions() {
        assert!(definitions("    if (ready(x)) {").is_empty());
        assert!(definitions("    foo(bar);").is_empty());
        assert!(definitions("    return compute(a, b);").is_empty());
        assert!(
            definitions("let x = 1;").is_empty(),
            "short names are ignored"
        );
    }

    #[test]
    fn compound_identifiers() {
        assert!(is_compound("granted_by_default"));
        assert!(is_compound("syncSecret"));
        assert!(is_compound("CORE_TO_AUTH"));
        assert!(!is_compound("handle"));
        assert!(!is_compound("_private"));
        assert!(!is_compound("a_b"));
    }

    #[test]
    fn same_edit_in_two_files_has_the_same_shape() {
        let a = edit_shape(
            ["al_dispatch(\\VK\\Controllers\\AudioController::class);"].into_iter(),
            [
                "use VK\\Controllers\\AudioController;",
                "$controller = new AudioController();",
                "$controller->handle();",
            ]
            .into_iter(),
        );
        let b = edit_shape(
            ["al_dispatch(\\VK\\Controllers\\FansController::class);"].into_iter(),
            [
                "use VK\\Controllers\\FansController;",
                "$controller = new FansController();",
                "$controller->handle();",
            ]
            .into_iter(),
        );
        assert!(a.is_some());
        assert_eq!(a, b);
    }

    #[test]
    fn formatting_and_tiny_edits_have_no_shape() {
        assert_eq!(
            edit_shape(["'a'   => $x,"].into_iter(), ["'a' => $x,"].into_iter()),
            None
        );
        assert_eq!(
            edit_shape(["newName(x);"].into_iter(), ["oldName(x);"].into_iter()),
            None
        );
        assert_eq!(edit_shape(["x"].into_iter(), [].into_iter()), None);
    }
}
