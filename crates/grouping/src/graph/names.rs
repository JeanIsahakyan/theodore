//! File-name signals: the "name root" two files share once role suffixes
//! are stripped (`fooController.ts` ~ `foo.service.ts` ~ `foo.test.ts`),
//! and whether a file is a test.

/// Trailing words that name a file's role, not its domain. Stripped from
/// the end of a file's stem until none is left: `installation-grant.controller`
/// and `installation-grant.service` share the root `installationgrant`.
const ROLE_SUFFIXES: &[&str] = &[
    "controller",
    "controllers",
    "router",
    "routes",
    "route",
    "service",
    "services",
    "repository",
    "repo",
    "handler",
    "handlers",
    "middleware",
    "callback",
    "callbacks",
    "internal",
    "store",
    "view",
    "views",
    "model",
    "models",
    "test",
    "tests",
    "spec",
    "e2e",
    "processor",
    "provider",
    "factory",
    "entity",
    "dto",
    "module",
    "resolver",
    "schema",
    "response",
    "request",
    "hook",
    "page",
    "screen",
    "component",
    "impl",
    "integration",
];

/// Roots too generic to say two files are about the same thing: every app
/// has a `config.ts`, every crate a `lib.rs`.
const GENERIC_ROOTS: &[&str] = &[
    "config",
    "configs",
    "index",
    "main",
    "lib",
    "mod",
    "init",
    "util",
    "utils",
    "helper",
    "helpers",
    "type",
    "types",
    "constant",
    "constants",
    "const",
    "common",
    "base",
    "app",
    "src",
    "setup",
    "readme",
    "package",
    "default",
    "defaults",
    "core",
    "error",
    "errors",
    "shared",
    "misc",
    "api",
    "server",
    "client",
    "migration",
    "migrations",
    "seed",
    "env",
    "deps",
    "dep",
    "style",
    "styles",
    "global",
    "globals",
    "changelog",
    "license",
    "makefile",
    "dockerfile",
    "cargo",
    "go",
    "build",
    "cmake",
    "cmakelist",
    "project",
    "settings",
    "root",
    "layout",
    "item",
    "list",
    "data",
    "page",
    "test",
    "spec",
    "fixture",
    "fixtures",
    "mock",
    "mocks",
    "helper",
    "support",
    "context",
    "state",
    "store",
    "provider",
    "router",
    "service",
    "model",
    "view",
    "controller",
    "schema",
    "module",
    "interface",
    "abstract",
    "plugin",
    "plugins",
    "exports",
    "component",
    "components",
    "hook",
    "hooks",
    "entry",
    "conftest",
    "manifest",
    "contract",
    "generated",
];

/// Stems whose folder is the real name: `foo/index.ts` is "foo".
const FOLDER_NAMED: &[&str] = &["index", "mod", "__init__"];

const CODE_EXTS: &[&str] = &[
    "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "vue", "svelte", "py", "rs", "go", "php",
    "cs", "java", "kt", "kts", "swift", "rb", "c", "cc", "cpp", "cxx", "h", "hh", "hpp", "m", "mm",
    "scala", "ex", "exs", "dart",
];

fn ext(path: &str) -> &str {
    let base = path.rsplit('/').next().unwrap_or(path);
    match base.rsplit_once('.') {
        Some((stem, e)) if !stem.is_empty() => e,
        _ => "",
    }
}

pub(crate) fn is_code(path: &str) -> bool {
    CODE_EXTS.contains(&ext(path).to_ascii_lowercase().as_str())
}

/// Split an identifier-ish stem into lowercase words on `-`, `_`, `.`,
/// spaces and camelCase humps (`AppClientStore` → app, client, store).
pub(crate) fn words(stem: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut prev_lower = false;
    for c in stem.chars() {
        if !c.is_alphanumeric() {
            if !cur.is_empty() {
                out.push(std::mem::take(&mut cur));
            }
            prev_lower = false;
            continue;
        }
        if c.is_uppercase() && prev_lower && !cur.is_empty() {
            out.push(std::mem::take(&mut cur));
        }
        prev_lower = c.is_lowercase() || c.is_ascii_digit();
        cur.extend(c.to_lowercase());
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// Whether `path` is a test file (by directory or by file-name convention).
/// Only code files count: a `specs/` folder of markdown is documentation.
pub(crate) fn is_test(path: &str) -> bool {
    if !is_code(path) {
        return false;
    }
    let lower = path.to_ascii_lowercase();
    let segments: Vec<&str> = lower.split('/').collect();
    let (dirs, base) = segments.split_at(segments.len() - 1);
    let base = base[0];
    if dirs.iter().any(|d| {
        matches!(
            *d,
            "test" | "tests" | "__tests__" | "spec" | "specs" | "e2e"
        )
    }) {
        return true;
    }
    let stem = base.split('.').next().unwrap_or(base);
    base.contains(".test.")
        || base.contains(".spec.")
        || base.contains("-spec.")
        || stem.ends_with("_test")
        || stem.starts_with("test_")
        || (stem.ends_with("test") && path.rsplit('/').next().is_some_and(|b| b.contains("Test")))
        || (stem.ends_with("tests") && path.rsplit('/').next().is_some_and(|b| b.contains("Tests")))
}

/// The domain name a file is about, or `None` when its name is too generic
/// to relate it to anything (`config.ts`, `main.rs`, dotfiles).
pub(crate) fn name_root(path: &str) -> Option<String> {
    let mut segments: Vec<&str> = path.split('/').collect();
    let base = segments.pop()?;
    if base.starts_with('.') {
        return None;
    }
    let mut stem = base.split('.').next().unwrap_or(base);
    if FOLDER_NAMED.contains(&stem) {
        stem = segments.pop()?;
    }
    let mut w = words(stem);
    // `test_foo.py`, `useFoo` (a React hook is about "foo").
    if w.len() > 1 && (w[0] == "test" || w[0] == "use") {
        w.remove(0);
    }
    while w.len() > 1
        && w.last()
            .is_some_and(|l| ROLE_SUFFIXES.contains(&l.as_str()))
    {
        w.pop();
    }
    if let Some(last) = w.last_mut()
        && last.len() > 3
        && last.ends_with('s')
        && !last.ends_with("ss")
    {
        last.pop();
    }
    let root: String = w.concat();
    if root.len() < 3
        || GENERIC_ROOTS.contains(&root.as_str())
        || ROLE_SUFFIXES.contains(&root.as_str())
    {
        return None;
    }
    Some(root)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_role_suffixes_across_naming_styles() {
        let r = |p| name_root(p);
        assert_eq!(r("src/user/UserController.php"), Some("user".into()));
        assert_eq!(r("src/user/user.service.ts"), Some("user".into()));
        assert_eq!(r("src/user/user-repository.ts"), Some("user".into()));
        assert_eq!(r("src/user/user_handler.go"), Some("user".into()));
        assert_eq!(r("tests/user_test.go"), Some("user".into()));
        assert_eq!(r("src/user.spec.ts"), Some("user".into()));
        assert_eq!(r("tests/test_user.py"), Some("user".into()));
        assert_eq!(
            r("lib/Controllers/FriendsController.php"),
            Some("friend".into())
        );
        assert_eq!(
            r("lib/Processors/FriendProcessor.php"),
            Some("friend".into())
        );
        assert_eq!(
            r("apps/core-api/src/installation-grant.controller.ts"),
            r("apps/core-api/src/installation-grant.service.ts")
        );
        assert_eq!(r("ui/src/hooks/useInbox.ts"), Some("inbox".into()));
    }

    #[test]
    fn index_files_take_their_folder_name() {
        assert_eq!(name_root("src/billing/index.ts"), Some("billing".into()));
        assert_eq!(name_root("src/billing/mod.rs"), Some("billing".into()));
        assert_eq!(name_root("pkg/billing/__init__.py"), Some("billing".into()));
    }

    #[test]
    fn generic_names_have_no_root() {
        assert_eq!(name_root("apps/auth/src/config.ts"), None);
        assert_eq!(name_root("crates/x/src/lib.rs"), None);
        assert_eq!(name_root("src/main.rs"), None);
        assert_eq!(name_root(".env.example"), None);
        assert_eq!(name_root("README.md"), None);
        assert_eq!(name_root("src/utils/index.ts"), None);
        assert_eq!(name_root("a/ab.ts"), None);
    }

    #[test]
    fn detects_tests() {
        assert!(is_test("src/user.test.ts"));
        assert!(is_test("apps/auth/test/auth.e2e-spec.ts"));
        assert!(is_test("pkg/user_test.go"));
        assert!(is_test("tests/test_user.py"));
        assert!(is_test("src/UserTest.php"));
        assert!(is_test("crates/x/tests/flow.rs"));
        assert!(!is_test("specs/platform/04-identity.md"));
        assert!(!is_test("src/latest.ts"));
        assert!(!is_test("src/user.ts"));
    }

    #[test]
    fn words_split_camel_and_separators() {
        assert_eq!(words("AppClientStore"), vec!["app", "client", "store"]);
        assert_eq!(
            words("grant-token_exchange"),
            vec!["grant", "token", "exchange"]
        );
        assert_eq!(words("HTTPServer"), vec!["httpserver"]);
    }
}
