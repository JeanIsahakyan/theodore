//! The variables every space command and agent run gets, and `$VAR`
//! expansion in `spaces.env` values (docs/config.md "Variables").

use std::collections::BTreeMap;

/// What a space's variables are made of.
#[derive(Debug, Clone, Default)]
pub struct SpaceVars {
    /// The space's name (a slug).
    pub space: String,
    pub id: String,
    pub ports: Vec<u16>,
    /// The project's main checkout (a local folder), if there is one.
    pub root: Option<String>,
    pub worktree: String,
    pub branch: String,
}

impl SpaceVars {
    /// `THEODORE_SPACE`, `THEODORE_SPACE_ID`, `THEODORE_PORT`,
    /// `THEODORE_PORT_1` … (`THEODORE_PORT` = `THEODORE_PORT_0`),
    /// `THEODORE_ROOT` (only with a checkout), `THEODORE_WORKTREE`,
    /// `THEODORE_BRANCH`.
    pub fn to_env(&self) -> Vec<(String, String)> {
        let mut out = vec![
            ("THEODORE_SPACE".to_string(), self.space.clone()),
            ("THEODORE_SPACE_ID".to_string(), self.id.clone()),
            ("THEODORE_WORKTREE".to_string(), self.worktree.clone()),
            ("THEODORE_BRANCH".to_string(), self.branch.clone()),
        ];
        if let Some(root) = &self.root {
            out.push(("THEODORE_ROOT".to_string(), root.clone()));
        }
        for (i, p) in self.ports.iter().enumerate() {
            if i == 0 {
                out.push(("THEODORE_PORT".to_string(), p.to_string()));
            }
            out.push((format!("THEODORE_PORT_{i}"), p.to_string()));
        }
        out
    }
}

/// Expands `$NAME` and `${NAME}` in `text` from `vars` (an unknown name
/// becomes empty, as in `sh`); `$$` is a literal `$`, and a `$` not
/// followed by a name stays as it is.
pub fn expand(text: &str, vars: &BTreeMap<String, String>) -> String {
    let mut out = String::with_capacity(text.len());
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c != '$' {
            out.push(c);
            i += 1;
            continue;
        }
        match chars.get(i + 1) {
            Some('$') => {
                out.push('$');
                i += 2;
            }
            Some('{') => match chars[i + 2..].iter().position(|&c| c == '}') {
                Some(len) => {
                    let name: String = chars[i + 2..i + 2 + len].iter().collect();
                    if is_name(&name) {
                        out.push_str(vars.get(&name).map(String::as_str).unwrap_or(""));
                    } else {
                        out.extend(&chars[i..i + 3 + len]);
                    }
                    i += 3 + len;
                }
                None => {
                    out.push('$');
                    i += 1;
                }
            },
            Some(&n) if n == '_' || n.is_ascii_alphabetic() => {
                let len = chars[i + 1..]
                    .iter()
                    .take_while(|c| **c == '_' || c.is_ascii_alphanumeric())
                    .count();
                let name: String = chars[i + 1..i + 1 + len].iter().collect();
                out.push_str(vars.get(&name).map(String::as_str).unwrap_or(""));
                i += 1 + len;
            }
            _ => {
                out.push('$');
                i += 1;
            }
        }
    }
    out
}

fn is_name(s: &str) -> bool {
    let mut chars = s.chars();
    chars
        .next()
        .is_some_and(|c| c == '_' || c.is_ascii_alphabetic())
        && chars.all(|c| c == '_' || c.is_ascii_alphanumeric())
}

/// The full environment added to a space's commands and agent runs:
/// the variables, then `spaces.env` with each value expanded against the
/// variables and the inherited environment (not against other `env`
/// keys: their order isn't defined).
pub fn space_env(
    vars: &SpaceVars,
    extra: &BTreeMap<String, String>,
    inherited: impl IntoIterator<Item = (String, String)>,
) -> Vec<(String, String)> {
    let theodore = vars.to_env();
    let mut lookup: BTreeMap<String, String> = inherited.into_iter().collect();
    lookup.extend(theodore.iter().cloned());
    let mut out = theodore;
    for (k, v) in extra {
        if !is_name(k) || k.starts_with("THEODORE_") {
            // Theodore's own variables are not overridable.
            continue;
        }
        out.push((k.clone(), expand(v, &lookup)));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars() -> BTreeMap<String, String> {
        [("THEODORE_SPACE", "fix-login"), ("THEODORE_PORT", "4100")]
            .into_iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn expands_both_forms() {
        let v = vars();
        assert_eq!(expand("db-$THEODORE_SPACE", &v), "db-fix-login");
        assert_eq!(
            expand("http://localhost:${THEODORE_PORT}/x", &v),
            "http://localhost:4100/x"
        );
        assert_eq!(expand("$THEODORE_SPACE_x", &v), "", "the name runs on");
        assert_eq!(expand("${THEODORE_SPACE}_x", &v), "fix-login_x");
    }

    #[test]
    fn unknown_is_empty_and_odd_dollars_stay() {
        let v = vars();
        assert_eq!(expand("a${NOPE}b", &v), "ab");
        assert_eq!(expand("cost $5 and $$HOME", &v), "cost $5 and $HOME");
        assert_eq!(expand("end $", &v), "end $");
        assert_eq!(expand("${not closed", &v), "${not closed");
        assert_eq!(expand("${a-b}", &v), "${a-b}");
    }

    #[test]
    fn space_env_has_the_variables_and_expanded_extras() {
        let sv = SpaceVars {
            space: "fix-login".into(),
            id: "abc123".into(),
            ports: vec![4100, 4101],
            root: None,
            worktree: "/w".into(),
            branch: "space/fix-login".into(),
        };
        let extra: BTreeMap<String, String> = [
            ("URL", "http://localhost:$THEODORE_PORT_1"),
            ("PATH", "$THEODORE_WORKTREE/bin:$PATH"),
            ("THEODORE_SPACE", "hijack"),
            ("NEXT", "$URL/api"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        let env = space_env(&sv, &extra, [("PATH".to_string(), "/usr/bin".to_string())]);
        let get = |k: &str| {
            env.iter()
                .filter(|(n, _)| n == k)
                .map(|(_, v)| v.as_str())
                .collect::<Vec<_>>()
        };
        assert_eq!(get("THEODORE_SPACE"), ["fix-login"]);
        assert_eq!(get("THEODORE_PORT"), ["4100"]);
        assert_eq!(get("THEODORE_PORT_0"), ["4100"]);
        assert_eq!(get("THEODORE_PORT_1"), ["4101"]);
        assert_eq!(get("THEODORE_ROOT"), Vec::<&str>::new());
        assert_eq!(get("URL"), ["http://localhost:4101"]);
        assert_eq!(get("PATH"), ["/w/bin:/usr/bin"]);
        assert_eq!(get("NEXT"), ["/api"], "other env keys aren't variables");
    }
}
