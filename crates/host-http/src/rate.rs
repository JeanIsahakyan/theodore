//! Rate-limit bookkeeping from `x-ratelimit-*` / `retry-after` response headers.

use std::hash::{DefaultHasher, Hash, Hasher};

use reqwest::header::HeaderMap;
type Millis = i64;

#[derive(Debug, Default)]
pub(crate) struct RateState {
    /// Last known remaining calls in the current window.
    remaining: Option<u64>,
    /// Earliest time (ms) a blocked caller may try again. Set from an actual
    /// 429/403 response so later calls can fail fast without a round trip.
    blocked_until_ms: Option<Millis>,
    /// Fingerprint of the token that earned the block. GitHub counts limits
    /// per token (and per IP with none), so a block earned unauthenticated
    /// (60/h, used up by polling before sign-in) must not stop the token the
    /// user just connected.
    blocked_token: u64,
}

impl RateState {
    pub(crate) fn preemptive_block(&self, now_ms: Millis, token: Option<&str>) -> Option<Millis> {
        match self.blocked_until_ms {
            Some(until) if until > now_ms && self.blocked_token == fingerprint(token) => {
                Some(until)
            }
            _ => None,
        }
    }

    pub(crate) fn observe(&mut self, headers: &HeaderMap) {
        if let Some(remaining) = header_u64(headers, "x-ratelimit-remaining") {
            self.remaining = Some(remaining);
        }
    }

    pub(crate) fn block_until(&mut self, until_ms: Millis, token: Option<&str>) {
        self.blocked_until_ms = Some(until_ms);
        self.blocked_token = fingerprint(token);
    }

    #[cfg(test)]
    pub(crate) fn remaining(&self) -> Option<u64> {
        self.remaining
    }
}

/// A hash rather than the token itself, so the secret isn't kept twice.
fn fingerprint(token: Option<&str>) -> u64 {
    let mut h = DefaultHasher::new();
    token.hash(&mut h);
    h.finish()
}

fn header_u64(headers: &HeaderMap, name: &str) -> Option<u64> {
    headers.get(name)?.to_str().ok()?.trim().parse().ok()
}

/// Reset time implied by `retry-after` (seconds, relative) or
/// `x-ratelimit-reset` (unix seconds, absolute). Falls back to `now + 60s`
/// when a 429/403 carries neither (GitHub always sends one, but other hosts
/// built on this client might not).
pub(crate) fn reset_at_from_headers(headers: &HeaderMap, now_ms: Millis) -> Millis {
    if let Some(secs) = header_u64(headers, "retry-after") {
        return now_ms + secs as i64 * 1000;
    }
    if let Some(epoch_secs) = header_u64(headers, "x-ratelimit-reset") {
        return epoch_secs as i64 * 1000;
    }
    now_ms + 60_000
}

/// Whether a 403 is really a rate limit (secondary limit / exhausted quota)
/// rather than an auth/scope rejection.
pub(crate) fn is_rate_limited_403(headers: &HeaderMap) -> bool {
    if headers.contains_key("retry-after") {
        return true;
    }
    header_u64(headers, "x-ratelimit-remaining") == Some(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::HeaderValue;

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(
                reqwest::header::HeaderName::from_bytes(k.as_bytes()).unwrap(),
                HeaderValue::from_str(v).unwrap(),
            );
        }
        h
    }

    #[test]
    fn observe_tracks_remaining_and_block_until_gates_preemptively() {
        let mut state = RateState::default();
        assert_eq!(state.remaining(), None);

        state.observe(&headers(&[("x-ratelimit-remaining", "12")]));
        assert_eq!(state.remaining(), Some(12));

        assert_eq!(state.preemptive_block(1_000, None), None);
        state.block_until(2_000, None);
        assert_eq!(state.preemptive_block(1_000, None), Some(2_000));
        assert_eq!(
            state.preemptive_block(2_000, None),
            None,
            "block expires at the deadline"
        );
    }

    #[test]
    fn a_block_only_holds_for_the_token_that_earned_it() {
        let mut state = RateState::default();
        state.block_until(2_000, None);
        assert_eq!(state.preemptive_block(1_000, Some("new")), None);

        state.block_until(2_000, Some("old"));
        assert_eq!(state.preemptive_block(1_000, Some("old")), Some(2_000));
        assert_eq!(state.preemptive_block(1_000, Some("new")), None);
        assert_eq!(state.preemptive_block(1_000, None), None);
    }

    #[test]
    fn reset_at_prefers_retry_after_over_ratelimit_reset() {
        let h = headers(&[("retry-after", "10"), ("x-ratelimit-reset", "999999")]);
        assert_eq!(reset_at_from_headers(&h, 5_000), 15_000);
    }

    #[test]
    fn reset_at_falls_back_to_ratelimit_reset_then_default() {
        let h = headers(&[("x-ratelimit-reset", "100")]);
        assert_eq!(reset_at_from_headers(&h, 0), 100_000);

        let none = HeaderMap::new();
        assert_eq!(reset_at_from_headers(&none, 5_000), 65_000);
    }

    #[test]
    fn is_rate_limited_403_requires_a_signal() {
        assert!(is_rate_limited_403(&headers(&[("retry-after", "5")])));
        assert!(is_rate_limited_403(&headers(&[(
            "x-ratelimit-remaining",
            "0"
        )])));
        assert!(!is_rate_limited_403(&headers(&[(
            "x-ratelimit-remaining",
            "3"
        )])));
        assert!(!is_rate_limited_403(&HeaderMap::new()));
    }
}
