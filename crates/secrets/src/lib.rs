//! Secrets in one OS keychain item (macOS via /usr/bin/security).
//!
//! All Theodore secrets live in ONE macOS keychain generic-password item:
//! - Service: `app.theodore.secrets`
//! - Account: `vault`
//! - Value: JSON object `{ "<key>": "<secret>", ... }`
//!
//! This ensures only one keychain ACL prompt when the binary changes.
//! Secrets are read via `/usr/bin/security find-generic-password` and written
//! interactively via `/usr/bin/security -i` to avoid exposing them in process arguments.

#![forbid(unsafe_code)]

use std::collections::HashMap;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use theodore_ports::Secrets;
use theodore_ports::SecretsError;

const VAULT_SERVICE: &str = "app.theodore.secrets";
const VAULT_ACCOUNT: &str = "vault";

/// Keys for secrets stored in the vault.
pub const GITHUB_TOKEN: &str = "github.token";
pub const GITLAB_TOKEN: &str = "gitlab.token";
pub const BITBUCKET_TOKEN: &str = "bitbucket.token";
pub const LINEAR_TOKEN: &str = "linear.token";
/// The Theodore account session (JSON: tokens + profile).
pub const THEODORE_ACCOUNT: &str = "theodore.account";

/// Trait to abstract command invocation for testability.
trait CommandRunner: Send + Sync {
    /// Run `/usr/bin/security find-generic-password -s <svc> -a <acct> -w`.
    /// Returns `Ok(Some(value))` on success, `Ok(None)` if not found, or an error.
    fn read_keychain(&self, service: &str, account: &str) -> Result<Option<String>, SecretsError>;

    /// Run `/usr/bin/security -i` with an interactive command to add/update a password.
    /// The command should be written to stdin, quoted properly for the security parser.
    fn write_keychain(&self, service: &str, account: &str, value: &str)
    -> Result<(), SecretsError>;
}

/// Real command runner using `/usr/bin/security`.
struct RealCommandRunner;

impl CommandRunner for RealCommandRunner {
    fn read_keychain(&self, service: &str, account: &str) -> Result<Option<String>, SecretsError> {
        let output = Command::new("/usr/bin/security")
            .args(["find-generic-password", "-s", service, "-a", account, "-w"])
            .output()
            .map_err(|e| SecretsError::Keychain(format!("failed to spawn security: {}", e)))?;

        if !output.status.success() {
            // Non-zero exit means not found or error. Check for user cancel (exit 128 or special message).
            if output.status.code() == Some(128)
                || String::from_utf8_lossy(&output.stderr).contains("user canceled")
            {
                return Err(SecretsError::Denied);
            }
            return Ok(None);
        }

        let value = String::from_utf8_lossy(&output.stdout)
            .trim_end()
            .to_string();

        if value.is_empty() {
            Ok(None)
        } else {
            Ok(Some(value))
        }
    }

    fn write_keychain(
        &self,
        service: &str,
        account: &str,
        value: &str,
    ) -> Result<(), SecretsError> {
        // Use interactive stdin to avoid passing the secret as a command-line argument.
        // Format: `add-generic-password -U -s <service> -a <account> -w <quoted>`.
        // No trailing `quit`: `security -i` has no such command (it exits
        // 0 on EOF, which closing `stdin` below already delivers) — a
        // bogus `quit` line makes the whole interactive session's exit
        // status 1 even though `add-generic-password` itself succeeded,
        // which previously made every real write look like a failure.
        let cmd = format!(
            "add-generic-password -U -s {} -a {} -w {}\n",
            security_quote(service),
            security_quote(account),
            security_quote(value)
        );

        let mut child = Command::new("/usr/bin/security")
            .arg("-i")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| SecretsError::Keychain(format!("failed to spawn security: {}", e)))?;

        {
            let stdin = child
                .stdin
                .as_mut()
                .ok_or(SecretsError::Keychain("stdin not available".to_string()))?;
            use std::io::Write;
            stdin
                .write_all(cmd.as_bytes())
                .map_err(|e| SecretsError::Keychain(format!("failed to write stdin: {}", e)))?;
        }

        let output = child
            .wait_with_output()
            .map_err(|e| SecretsError::Keychain(format!("failed to wait on security: {}", e)))?;

        if !output.status.success() {
            // Check for user cancel.
            if output.status.code() == Some(128)
                || String::from_utf8_lossy(&output.stderr).contains("user canceled")
            {
                return Err(SecretsError::Denied);
            }
            return Err(SecretsError::Keychain(format!(
                "security exited with status {:?}: {}",
                output.status.code(),
                String::from_utf8_lossy(&output.stderr)
            )));
        }

        Ok(())
    }
}

/// Quote a string for `/usr/bin/security -i`'s interactive command parser.
///
/// This is NOT a shell — its quoting rules are undocumented (no man page
/// section covers them) and were verified empirically against the real
/// `security` binary (see the `#[ignore]`d `real_keychain_roundtrip*`
/// tests below) rather than assumed from shell convention:
///
/// - A single-quoted string does *not* support the POSIX `'\''` trick to
///   embed a literal `'` — `security` rejects it outright (extra tokens,
///   "Usage: add-generic-password" on stderr). Never use single quotes
///   for a value that might contain one.
/// - A double-quoted string supports exactly two escapes: `\\` for a
///   literal backslash and `\"` for a literal double quote. A backslash
///   before any other character is silently dropped (`"a\tb"` stores
///   `atb`, not a tab) — so this must never be asked to pass through an
///   escape sequence it doesn't itself produce.
/// - A literal control character (real tab, real newline) in the value
///   can't be represented at all: `security -i` reads one command per
///   line, so a raw `\n` byte ends the command early. Callers must keep
///   the text handed to this function free of raw control bytes and
///   non-ASCII bytes — `KeychainSecrets` does this by only ever quoting
///   the output of `ascii_escape_json`, which turns both into plain-ASCII
///   `\u00XX` / backslash-letter escapes before this function ever sees
///   them.
fn security_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Re-escapes every non-ASCII character of a JSON string as `\uXXXX`
/// (surrogate pairs for anything past `U+FFFF`), on top of `serde_json`'s
/// own escaping of control characters, `"` and `\`. The result is always
/// pure printable ASCII.
///
/// This exists because `/usr/bin/security find-generic-password -w`
/// prints the hex encoding of the password instead of the password
/// itself whenever it contains a byte outside `isprint()` — which
/// includes every non-ASCII UTF-8 continuation byte. A vault value with
/// so much as one accented character or emoji would otherwise make the
/// *entire* vault blob unreadable (the hex dump doesn't parse as JSON).
/// Keeping the on-keychain bytes pure ASCII sidesteps that entirely;
/// `serde_json::from_str` undoes the `\u` escapes transparently on read.
fn ascii_escape_json(json: &str) -> String {
    let mut out = String::with_capacity(json.len());
    for c in json.chars() {
        if c.is_ascii() {
            out.push(c);
        } else {
            let mut buf = [0u16; 2];
            for unit in c.encode_utf16(&mut buf) {
                out.push_str(&format!("\\u{unit:04x}"));
            }
        }
    }
    out
}

/// Keychain-backed secrets (macOS production implementation).
///
/// `cache` and `write_lock` are two separate mutexes on purpose: `write_lock`
/// is held for the *entire* read-modify-write of `set`/`delete` (one lock
/// covering load, mutate and save), so two concurrent calls can never
/// interleave their load and save and silently drop each other's write.
/// `cache` is the inner, short-lived lock `load_vault`/`save_vault` use to
/// touch the cached snapshot; `get` only needs that one.
pub struct KeychainSecrets {
    cache: Mutex<Option<HashMap<String, String>>>,
    write_lock: Mutex<()>,
    runner: Box<dyn CommandRunner>,
}

impl KeychainSecrets {
    /// Create a new keychain secrets store with the real command runner.
    pub fn new() -> Self {
        Self {
            cache: Mutex::new(None),
            write_lock: Mutex::new(()),
            runner: Box::new(RealCommandRunner),
        }
    }

    /// Create a new keychain secrets store with a custom command runner (for testing).
    #[cfg(test)]
    fn with_runner(runner: Box<dyn CommandRunner>) -> Self {
        Self {
            cache: Mutex::new(None),
            write_lock: Mutex::new(()),
            runner,
        }
    }

    /// Load the vault from the keychain (or return cached).
    fn load_vault(&self) -> Result<HashMap<String, String>, SecretsError> {
        let mut cache = self
            .cache
            .lock()
            .map_err(|_| SecretsError::Keychain("mutex poisoned".to_string()))?;

        if let Some(vault) = cache.as_ref() {
            return Ok(vault.clone());
        }

        let json_str = match self.runner.read_keychain(VAULT_SERVICE, VAULT_ACCOUNT)? {
            Some(s) => s,
            None => {
                // No vault yet; return empty map.
                let empty = HashMap::new();
                *cache = Some(empty.clone());
                return Ok(empty);
            }
        };

        let vault: HashMap<String, String> = serde_json::from_str(&json_str)
            .map_err(|e| SecretsError::Keychain(format!("invalid vault JSON: {}", e)))?;

        *cache = Some(vault.clone());
        Ok(vault)
    }

    /// Save the vault to the keychain. The stored text is always pure
    /// ASCII (see `ascii_escape_json`) so a later `read_keychain` never
    /// hits `security`'s hex-dump-on-non-printable fallback.
    fn save_vault(&self, vault: &HashMap<String, String>) -> Result<(), SecretsError> {
        let json_str = serde_json::to_string(vault)
            .map_err(|e| SecretsError::Keychain(format!("failed to serialize vault: {}", e)))?;
        let json_str = ascii_escape_json(&json_str);

        self.runner
            .write_keychain(VAULT_SERVICE, VAULT_ACCOUNT, &json_str)?;

        // Update cache.
        let mut cache = self
            .cache
            .lock()
            .map_err(|_| SecretsError::Keychain("mutex poisoned".to_string()))?;
        *cache = Some(vault.clone());

        Ok(())
    }

    /// Load, apply `mutate`, save — all under `write_lock`, so a concurrent
    /// `set`/`delete` can't read the vault before this one's save lands and
    /// overwrite it with a stale copy (lost update).
    fn mutate_vault(
        &self,
        mutate: impl FnOnce(&mut HashMap<String, String>),
    ) -> Result<(), SecretsError> {
        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| SecretsError::Keychain("mutex poisoned".to_string()))?;
        let mut vault = self.load_vault()?;
        mutate(&mut vault);
        self.save_vault(&vault)
    }
}

impl Secrets for KeychainSecrets {
    fn get(&self, key: &str) -> Result<Option<String>, SecretsError> {
        let vault = self.load_vault()?;
        Ok(vault.get(key).cloned())
    }

    fn set(&self, key: &str, value: &str) -> Result<(), SecretsError> {
        self.mutate_vault(|vault| {
            vault.insert(key.to_string(), value.to_string());
        })
    }

    fn delete(&self, key: &str) -> Result<(), SecretsError> {
        self.mutate_vault(|vault| {
            vault.remove(key);
        })
    }
}

impl Default for KeychainSecrets {
    fn default() -> Self {
        Self::new()
    }
}

/// In-memory secrets store for tests and fixtures.
pub struct MemorySecrets {
    vault: Mutex<HashMap<String, String>>,
}

impl MemorySecrets {
    /// Create a new in-memory secrets store.
    pub fn new() -> Self {
        Self {
            vault: Mutex::new(HashMap::new()),
        }
    }

    /// Create with initial secrets.
    pub fn with_secrets(secrets: HashMap<String, String>) -> Self {
        Self {
            vault: Mutex::new(secrets),
        }
    }
}

impl Default for MemorySecrets {
    fn default() -> Self {
        Self::new()
    }
}

impl Secrets for MemorySecrets {
    fn get(&self, key: &str) -> Result<Option<String>, SecretsError> {
        let vault = self
            .vault
            .lock()
            .map_err(|_| SecretsError::Keychain("mutex poisoned".to_string()))?;
        Ok(vault.get(key).cloned())
    }

    fn set(&self, key: &str, value: &str) -> Result<(), SecretsError> {
        let mut vault = self
            .vault
            .lock()
            .map_err(|_| SecretsError::Keychain("mutex poisoned".to_string()))?;
        vault.insert(key.to_string(), value.to_string());
        Ok(())
    }

    fn delete(&self, key: &str) -> Result<(), SecretsError> {
        let mut vault = self
            .vault
            .lock()
            .map_err(|_| SecretsError::Keychain("mutex poisoned".to_string()))?;
        vault.remove(key);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fake command runner for testing.
    struct FakeCommandRunner {
        vault: Mutex<Option<String>>,
        deny_next_write: Mutex<bool>,
    }

    impl FakeCommandRunner {
        fn new() -> Self {
            Self {
                vault: Mutex::new(None),
                deny_next_write: Mutex::new(false),
            }
        }

        fn with_vault(json: &str) -> Self {
            Self {
                vault: Mutex::new(Some(json.to_string())),
                deny_next_write: Mutex::new(false),
            }
        }
    }

    impl CommandRunner for FakeCommandRunner {
        fn read_keychain(
            &self,
            _service: &str,
            _account: &str,
        ) -> Result<Option<String>, SecretsError> {
            let vault = self.vault.lock().unwrap();
            Ok(vault.clone())
        }

        fn write_keychain(
            &self,
            _service: &str,
            _account: &str,
            value: &str,
        ) -> Result<(), SecretsError> {
            if *self.deny_next_write.lock().unwrap() {
                *self.deny_next_write.lock().unwrap() = false;
                return Err(SecretsError::Denied);
            }
            *self.vault.lock().unwrap() = Some(value.to_string());
            Ok(())
        }
    }

    #[test]
    fn test_memory_secrets_basic() {
        let secrets = MemorySecrets::new();
        assert!(secrets.get("key1").unwrap().is_none());

        secrets.set("key1", "value1").unwrap();
        assert_eq!(secrets.get("key1").unwrap(), Some("value1".to_string()));

        secrets.set("key1", "value2").unwrap();
        assert_eq!(secrets.get("key1").unwrap(), Some("value2".to_string()));

        secrets.delete("key1").unwrap();
        assert!(secrets.get("key1").unwrap().is_none());
    }

    #[test]
    fn test_memory_secrets_multiple_keys() {
        let secrets = MemorySecrets::new();
        secrets.set(GITHUB_TOKEN, "gh_token").unwrap();
        secrets.set(GITLAB_TOKEN, "gl_token").unwrap();
        secrets.set(BITBUCKET_TOKEN, "bb_token").unwrap();

        assert_eq!(
            secrets.get(GITHUB_TOKEN).unwrap(),
            Some("gh_token".to_string())
        );
        assert_eq!(
            secrets.get(GITLAB_TOKEN).unwrap(),
            Some("gl_token".to_string())
        );
        assert_eq!(
            secrets.get(BITBUCKET_TOKEN).unwrap(),
            Some("bb_token".to_string())
        );
    }

    #[test]
    fn test_keychain_secrets_empty_vault() {
        let runner = Box::new(FakeCommandRunner::new());
        let secrets = KeychainSecrets::with_runner(runner);

        // No vault exists; should return None.
        assert!(secrets.get("key1").unwrap().is_none());
    }

    #[test]
    fn test_keychain_secrets_get_set_delete() {
        let runner = Box::new(FakeCommandRunner::new());
        let secrets = KeychainSecrets::with_runner(runner);

        // Set a key.
        secrets.set("key1", "value1").unwrap();
        assert_eq!(secrets.get("key1").unwrap(), Some("value1".to_string()));

        // Set another key.
        secrets.set("key2", "value2").unwrap();
        assert_eq!(secrets.get("key2").unwrap(), Some("value2".to_string()));
        assert_eq!(secrets.get("key1").unwrap(), Some("value1".to_string()));

        // Delete a key.
        secrets.delete("key1").unwrap();
        assert!(secrets.get("key1").unwrap().is_none());
        assert_eq!(secrets.get("key2").unwrap(), Some("value2".to_string()));
    }

    #[test]
    fn test_keychain_secrets_overwrites_on_set() {
        let runner = Box::new(FakeCommandRunner::new());
        let secrets = KeychainSecrets::with_runner(runner);

        secrets.set("key", "value1").unwrap();
        assert_eq!(secrets.get("key").unwrap(), Some("value1".to_string()));

        secrets.set("key", "value2").unwrap();
        assert_eq!(secrets.get("key").unwrap(), Some("value2".to_string()));
    }

    #[test]
    fn test_keychain_secrets_with_existing_vault() {
        let initial_vault = r#"{"github.token":"gh_123","gitlab.token":"gl_456"}"#;
        let runner = Box::new(FakeCommandRunner::with_vault(initial_vault));
        let secrets = KeychainSecrets::with_runner(runner);

        assert_eq!(
            secrets.get(GITHUB_TOKEN).unwrap(),
            Some("gh_123".to_string())
        );
        assert_eq!(
            secrets.get(GITLAB_TOKEN).unwrap(),
            Some("gl_456".to_string())
        );

        // Modify one and add a new key.
        secrets.set(GITHUB_TOKEN, "gh_789").unwrap();
        secrets.set(BITBUCKET_TOKEN, "bb_000").unwrap();

        assert_eq!(
            secrets.get(GITHUB_TOKEN).unwrap(),
            Some("gh_789".to_string())
        );
        assert_eq!(
            secrets.get(GITLAB_TOKEN).unwrap(),
            Some("gl_456".to_string())
        );
        assert_eq!(
            secrets.get(BITBUCKET_TOKEN).unwrap(),
            Some("bb_000".to_string())
        );
    }

    #[test]
    fn test_security_quote_simple() {
        assert_eq!(security_quote("hello"), "\"hello\"");
    }

    #[test]
    fn test_security_quote_with_spaces() {
        assert_eq!(security_quote("hello world"), "\"hello world\"");
    }

    #[test]
    fn test_security_quote_with_single_quotes() {
        // A single quote needs no escaping inside a double-quoted value —
        // `security -i` has no special meaning for `'` there.
        assert_eq!(security_quote("it's"), "\"it's\"");
        assert_eq!(security_quote("a'b'c"), "\"a'b'c\"");
    }

    #[test]
    fn test_security_quote_with_double_quotes_and_backslashes() {
        assert_eq!(security_quote(r#"say "hi""#), r#""say \"hi\"""#);
        assert_eq!(security_quote(r"back\slash"), r#""back\\slash""#);
    }

    #[test]
    fn test_security_quote_with_unicode() {
        // Not escaped by `security_quote` itself — callers must have
        // already run the text through `ascii_escape_json` first.
        assert_eq!(security_quote("café"), "\"café\"");
        assert_eq!(security_quote("你好"), "\"你好\"");
    }

    #[test]
    fn test_ascii_escape_json_escapes_non_ascii_only() {
        let json = serde_json::to_string(&"café 你好 😀 plain \"q\" \\b\\").unwrap();
        let escaped = ascii_escape_json(&json);
        assert!(escaped.is_ascii());
        let back: String = serde_json::from_str(&escaped).unwrap();
        assert_eq!(back, "café 你好 😀 plain \"q\" \\b\\");
    }

    #[test]
    fn test_json_with_special_chars() {
        let secrets = MemorySecrets::new();
        let value = r#"{"key":"value with "quotes" and \backslash"}"#;
        secrets.set("special", value).unwrap();
        assert_eq!(secrets.get("special").unwrap(), Some(value.to_string()));
    }

    #[test]
    fn test_vault_json_escaping() {
        let runner = Box::new(FakeCommandRunner::new());
        let secrets = KeychainSecrets::with_runner(runner);

        // Set a secret with special JSON characters.
        let json_value = r#"{"nested": "value"}"#;
        secrets.set("json_key", json_value).unwrap();

        // The vault should round-trip correctly.
        assert_eq!(
            secrets.get("json_key").unwrap(),
            Some(json_value.to_string())
        );
    }

    #[test]
    fn test_vault_serialization_roundtrip() {
        let runner = Box::new(FakeCommandRunner::new());
        let secrets = KeychainSecrets::with_runner(runner);

        // Create a vault with multiple keys.
        secrets.set(GITHUB_TOKEN, "gh_token").unwrap();
        secrets.set(GITLAB_TOKEN, "gl_token").unwrap();
        secrets.set("custom.key", "custom_value").unwrap();

        // The vault should be properly serialized and deserializable.
        // Verify the data is consistent.
        assert_eq!(
            secrets.get(GITHUB_TOKEN).unwrap(),
            Some("gh_token".to_string())
        );
        assert_eq!(
            secrets.get(GITLAB_TOKEN).unwrap(),
            Some("gl_token".to_string())
        );
        assert_eq!(
            secrets.get("custom.key").unwrap(),
            Some("custom_value".to_string())
        );
    }

    #[test]
    fn test_denied_write_error() {
        let runner = FakeCommandRunner::new();
        *runner.deny_next_write.lock().unwrap() = true;
        let secrets = KeychainSecrets::with_runner(Box::new(runner));

        match secrets.set("key", "value") {
            Err(SecretsError::Denied) => {} // Expected
            other => panic!("Expected Denied error, got {:?}", other),
        }
    }

    /// Never the real `VAULT_SERVICE`/`VAULT_ACCOUNT` — a throwaway item,
    /// deleted in `Drop` regardless of how the test exits.
    const TEST_SERVICE: &str = "app.theodore.test.secrets.rust-review-23";
    const TEST_ACCOUNT: &str = "roundtrip";

    struct DeleteTestItemOnDrop;

    impl Drop for DeleteTestItemOnDrop {
        fn drop(&mut self) {
            let _ = Command::new("/usr/bin/security")
                .args([
                    "delete-generic-password",
                    "-s",
                    TEST_SERVICE,
                    "-a",
                    TEST_ACCOUNT,
                ])
                .output();
        }
    }

    /// Exercises the real `/usr/bin/security -i` / `find-generic-password`
    /// against a throwaway test-only item, through the exact same code
    /// `KeychainSecrets` uses (`RealCommandRunner`, `security_quote`,
    /// `ascii_escape_json`) — not a fake. Covers the characters finding
    /// #23 flagged as unverified: quotes (both kinds), backslashes,
    /// spaces, a newline, and unicode (accented, CJK, emoji).
    ///
    /// Run manually: grant keychain access when prompted.
    ///   cargo test --package theodore-secrets -- --ignored --nocapture real_keychain_roundtrip
    #[test]
    #[ignore]
    fn real_keychain_roundtrip() {
        let _cleanup = DeleteTestItemOnDrop;
        // Best-effort: clear any leftover item from a previous crashed run.
        drop(
            Command::new("/usr/bin/security")
                .args([
                    "delete-generic-password",
                    "-s",
                    TEST_SERVICE,
                    "-a",
                    TEST_ACCOUNT,
                ])
                .output(),
        );

        let value =
            "it's a \"test\" with \\backslash\\, a newline\nand unicode: café 你好 😀 and a tab\t.";
        let mut vault = HashMap::new();
        vault.insert(GITHUB_TOKEN.to_string(), value.to_string());
        vault.insert("other".to_string(), "plain".to_string());

        let runner = RealCommandRunner;
        let json = serde_json::to_string(&vault).unwrap();
        let encoded = ascii_escape_json(&json);
        assert!(
            encoded.is_ascii(),
            "the on-keychain text must be pure ASCII or `security -w` may \
             hex-dump it back instead of the real value"
        );

        runner
            .write_keychain(TEST_SERVICE, TEST_ACCOUNT, &encoded)
            .expect("write to the real keychain");

        let read_back = runner
            .read_keychain(TEST_SERVICE, TEST_ACCOUNT)
            .expect("read from the real keychain")
            .expect("item was just written");
        let decoded: HashMap<String, String> = serde_json::from_str(&read_back)
            .expect("the stored text must still parse as the original JSON");

        assert_eq!(decoded, vault, "value must round-trip byte-for-byte");
    }

    /// Regression guard for the `set`/`delete` race: two concurrent `set`
    /// calls on different keys must never lose one another's write. A
    /// `write_keychain` that takes a moment (standing in for the real
    /// `security` CLI's I/O) widens the window; a `Barrier` lines both
    /// threads up to start their `set` at the same instant, so the race
    /// reproduces every run under the old load→mutate→save-under-separate-
    /// locks code instead of only occasionally.
    struct SlowCommandRunner {
        vault: Mutex<Option<String>>,
        write_delay: std::time::Duration,
    }

    impl CommandRunner for SlowCommandRunner {
        fn read_keychain(
            &self,
            _service: &str,
            _account: &str,
        ) -> Result<Option<String>, SecretsError> {
            Ok(self.vault.lock().unwrap().clone())
        }

        fn write_keychain(
            &self,
            _service: &str,
            _account: &str,
            value: &str,
        ) -> Result<(), SecretsError> {
            std::thread::sleep(self.write_delay);
            *self.vault.lock().unwrap() = Some(value.to_string());
            Ok(())
        }
    }

    #[test]
    fn concurrent_set_calls_do_not_lose_each_others_writes() {
        use std::sync::{Arc, Barrier};
        use std::time::Duration;

        let secrets = Arc::new(KeychainSecrets::with_runner(Box::new(SlowCommandRunner {
            vault: Mutex::new(None),
            write_delay: Duration::from_millis(50),
        })));
        // Warm the cache so both threads' first `load_vault` is a cheap
        // cache hit, not a call into `read_keychain` — otherwise the two
        // reads would themselves serialize on the cache lock and the test
        // would prove nothing about `set`/`delete`'s own race.
        secrets.set("seed", "0").unwrap();

        let barrier = Arc::new(Barrier::new(2));
        let run = |key: &'static str, value: &'static str| {
            let secrets = secrets.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                secrets.set(key, value).unwrap();
            })
        };
        let a = run("key.a", "a");
        let b = run("key.b", "b");
        a.join().unwrap();
        b.join().unwrap();

        assert_eq!(secrets.get("seed").unwrap(), Some("0".to_string()));
        assert_eq!(
            secrets.get("key.a").unwrap(),
            Some("a".to_string()),
            "key.a must survive a concurrent set of key.b"
        );
        assert_eq!(
            secrets.get("key.b").unwrap(),
            Some("b".to_string()),
            "key.b must survive a concurrent set of key.a"
        );
    }
}
