//! The ETag `get_pr` hands back: the PR resource's own, plus the head
//! commit's check runs and commit statuses.
//!
//! A check finishing changes neither the PR resource nor its ETag, so a
//! 304 on `/pulls/{n}` alone says nothing about checks; the Checks tab
//! would keep whatever it saw first. All three are asked conditionally, so
//! an unchanged PR still costs only 304s (free against the rate limit).
//!
//! ```text
//! GET pulls/{n}                     If-None-Match: pull ─┐
//! GET commits/{head}/check-runs     If-None-Match: runs ─┼─ all 304 ─▶ NotModified
//! GET commits/{head}/status         If-None-Match: statuses ─┘
//!                                                        └─ any 200 ─▶ GraphQL detail
//! ```
//!
//! Opaque to callers: it's JSON so a value from before this format (a bare
//! ETag) or garbage parses as "nothing known" and the next fetch is a full
//! one.

use serde::{Deserialize, Serialize};

#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct PrEtag {
    /// `GET repos/{o}/{r}/pulls/{n}`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pull: Option<String>,
    /// The head commit the two below are for.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head: Option<String>,
    /// `GET .../commits/{head}/check-runs`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runs: Option<String>,
    /// `GET .../commits/{head}/status`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub statuses: Option<String>,
    /// The token may not read this head's checks (a fine-grained token
    /// without "Checks: read"): not asked again until the head moves, so a
    /// refusal isn't logged every poll. The PR's own ETag still applies.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub no_checks: bool,
}

impl PrEtag {
    pub(crate) fn parse(etag: Option<&str>) -> Self {
        etag.and_then(|e| serde_json::from_str(e).ok())
            .unwrap_or_default()
    }

    pub(crate) fn encode(&self) -> String {
        serde_json::to_string(self).expect("PrEtag always serializes")
    }

    /// The head moved: what was known about the old head's checks is moot.
    pub(crate) fn move_head(&mut self, head: Option<String>) {
        if head != self.head {
            self.head = head;
            self.runs = None;
            self.statuses = None;
            self.no_checks = false;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips() {
        let e = PrEtag {
            pull: Some("W/\"p1\"".into()),
            head: Some("abc".into()),
            runs: Some("\"r1\"".into()),
            statuses: None,
            no_checks: false,
        };
        assert_eq!(PrEtag::parse(Some(&e.encode())), e);
    }

    #[test]
    fn a_bare_etag_or_none_is_nothing_known() {
        assert_eq!(PrEtag::parse(Some("\"rest-etag-1\"")), PrEtag::default());
        assert_eq!(PrEtag::parse(None), PrEtag::default());
    }

    #[test]
    fn a_new_head_forgets_the_old_heads_checks() {
        let mut e = PrEtag {
            pull: Some("p".into()),
            head: Some("old".into()),
            runs: Some("r".into()),
            statuses: Some("s".into()),
            no_checks: true,
        };
        e.move_head(Some("old".into()));
        assert_eq!(e.runs.as_deref(), Some("r"), "same head: kept");
        e.move_head(Some("new".into()));
        assert_eq!(
            e,
            PrEtag {
                pull: Some("p".into()),
                head: Some("new".into()),
                ..PrEtag::default()
            }
        );
    }
}
