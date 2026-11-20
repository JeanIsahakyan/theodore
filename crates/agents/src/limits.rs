//! Each CLI's usage-limit signals, read into one `AgentLimit` (docs/plan.md
//! "Agent accounts and limits").
//!
//! ```text
//! Claude Code  rate_limit_event.rate_limit_info ──▶ claude_rate_limit ─┐
//! Codex        rate_limits {primary, secondary} ──▶ codex_rate_limits ─┼─▶ AgentLimit
//! any CLI      error message / stderr          ──▶ limit_in_error ────┘   (limited)
//! ```
//!
//! `limit_in_error` is only ever fed a run's error message and stderr, never
//! the agent's own reply: a model that writes "you've hit your limit" in its
//! answer must not mark the account limited.

use chrono::{DateTime, Datelike, Duration, NaiveDate, TimeZone};
use serde_json::{Map, Value};
use theodore_domain::{AgentId, AgentLimit, LimitStatus, Millis};

/// Claude Code's `rate_limit_info` (2.1.329's schema): `status`
/// (`allowed` / `allowed_warning` / `rejected`), `resetsAt` (unix s),
/// `rateLimitType` (the window), `utilization` (a fraction, may pass 1) and
/// `unifiedWindows` (per window `{utilization, resetsAt}`). Without a
/// top-level `utilization`, the fullest unified window gives it (and its
/// reset and name, when those are missing too). An unknown status → `None`.
pub fn claude_rate_limit(info: &Value) -> Option<AgentLimit> {
    let Some(obj) = info.as_object() else {
        tracing::debug!(
            kind = json_kind(info),
            "rate_limit_info isn't an object; ignored"
        );
        return None;
    };
    let status = match obj.get("status").and_then(Value::as_str) {
        Some("allowed") => LimitStatus::Ok,
        Some("allowed_warning") => LimitStatus::Warning,
        Some("rejected") => LimitStatus::Limited,
        status => {
            tracing::debug!(
                keys = ?keys_of(obj),
                status = status.unwrap_or("<none>"),
                "rate_limit_info with an unknown status; ignored"
            );
            return None;
        }
    };
    let mut window = obj
        .get("rateLimitType")
        .and_then(Value::as_str)
        .map(str::to_string);
    let mut used_pct = obj
        .get("utilization")
        .and_then(Value::as_f64)
        .map(|u| u * 100.0);
    let mut resets_at = obj.get("resetsAt").and_then(unix_secs_to_ms);
    if used_pct.is_none() {
        let fullest = obj
            .get("unifiedWindows")
            .and_then(Value::as_object)
            .into_iter()
            .flatten()
            .filter_map(|(name, w)| Some((name, w.get("utilization")?.as_f64()?, w)))
            .max_by(|a, b| a.1.total_cmp(&b.1));
        if let Some((name, utilization, w)) = fullest {
            used_pct = Some(utilization * 100.0);
            resets_at = resets_at.or_else(|| w.get("resetsAt").and_then(unix_secs_to_ms));
            window = window.or_else(|| Some(name.clone()));
        }
    }
    Some(AgentLimit {
        status,
        resets_at,
        window,
        used_pct,
    })
}

/// A Codex rate-limit snapshot (`rate_limits`: `primary` / `secondary`, each
/// `{used_percent, window_minutes, resets_at | resets_in_seconds}`), as the
/// window closest to its limit: limited at 100 %, a warning from 90 %.
pub fn codex_rate_limits(v: &Value) -> Option<AgentLimit> {
    codex_rate_limits_at(v, chrono::Utc::now().timestamp_millis())
}

/// [`codex_rate_limits`] with `now` (unix ms) for `resets_in_seconds`.
pub fn codex_rate_limits_at(v: &Value, now_ms: Millis) -> Option<AgentLimit> {
    let Some(obj) = v.as_object() else {
        tracing::debug!(kind = json_kind(v), "rate_limits isn't an object; ignored");
        return None;
    };
    let fullest = ["primary", "secondary"]
        .into_iter()
        .filter_map(|key| {
            let w = obj.get(key)?;
            Some((key, w.get("used_percent")?.as_f64()?, w))
        })
        .max_by(|a, b| a.1.total_cmp(&b.1));
    let Some((key, used, w)) = fullest else {
        tracing::debug!(keys = ?keys_of(obj), "rate_limits without a known window; ignored");
        return None;
    };
    let status = if used >= 100.0 {
        LimitStatus::Limited
    } else if used >= 90.0 {
        LimitStatus::Warning
    } else {
        LimitStatus::Ok
    };
    let resets_at = w.get("resets_at").and_then(unix_secs_to_ms).or_else(|| {
        let secs = w.get("resets_in_seconds")?.as_f64()?;
        Some(now_ms + (secs * 1000.0) as Millis)
    });
    let window = match w.get("window_minutes").and_then(Value::as_u64) {
        Some(300) => "five_hour",
        Some(10_080) => "seven_day",
        _ => key,
    };
    Some(AgentLimit {
        status,
        resets_at,
        window: Some(window.to_string()),
        used_pct: Some(used),
    })
}

/// `Some(limited)` when `text` (a run's error message or stderr, never the
/// agent's reply) says the account ran out of usage, with its reset when the
/// text gives one. Wall-clock resets are read in `now`'s zone (a zone name
/// in parentheses after them is ignored); a time with no date that already
/// passed today is tomorrow's.
///
/// | agent  | says                                                         | reset                                   |
/// |--------|--------------------------------------------------------------|-----------------------------------------|
/// | claude | `You've hit your … limit`, `You've reached your …`, `You're out of usage credits`, `Your org is out of usage`; older `Claude AI usage limit reached\|<unix s>` | `· resets 6pm`, `· resets Nov 20, 6pm` |
/// | codex  | `You’ve hit your usage limit…`, `usage_limit_reached` and the other limit codes | `Try again at Nov 20, 2026 6:05 PM.`, `try again in 3h 5m` |
/// | gemini | `RESOURCE_EXHAUSTED`, a 429, `Quota exceeded`                | `Please retry in 23.5s`, `"retryDelay":"23s"` |
///
/// Claude's per-minute API 429 (`rate_limit_error`) is not a usage limit:
/// Claude Code retries it by itself.
pub fn limit_in_error<Tz: TimeZone>(
    agent: AgentId,
    text: &str,
    now: DateTime<Tz>,
) -> Option<AgentLimit> {
    // Curly apostrophes (Codex writes `You’ve`) read as straight ones.
    let text = text.replace('\u{2019}', "'");
    let lower = text.to_lowercase();
    match agent {
        AgentId::Claude => claude_limit(&lower, &now),
        AgentId::Codex => codex_limit(&lower, &now),
        AgentId::Gemini => gemini_limit(&text, &lower, &now),
    }
}

/// How Claude Code 2.1.329 opens a usage-limit message.
const CLAUDE_LIMIT_OPENINGS: &[&str] = &[
    "you've hit your",
    "you've reached your",
    "you're out of usage credits",
    "your org is out of usage",
];

/// Older Claude Code: `Claude AI usage limit reached|<unix s>`.
const CLAUDE_LEGACY: &str = "claude ai usage limit reached";

fn claude_limit<Tz: TimeZone>(lower: &str, now: &DateTime<Tz>) -> Option<AgentLimit> {
    if let Some(at) = lower.find(CLAUDE_LEGACY) {
        let rest = &lower[at + CLAUDE_LEGACY.len()..];
        let resets_at = rest
            .strip_prefix('|')
            .map(|r| {
                r.chars()
                    .take_while(char::is_ascii_digit)
                    .collect::<String>()
            })
            .and_then(|digits| digits.parse::<i64>().ok())
            .map(|secs| secs * 1000);
        return Some(AgentLimit::limited(resets_at));
    }
    let line = limit_sentence(lower, CLAUDE_LIMIT_OPENINGS)?;
    let resets_at = line
        .find("resets ")
        .and_then(|at| wall_clock(&line[at + "resets ".len()..], now));
    Some(AgentLimit::limited(resets_at))
}

/// The error codes Codex 0.169.0 gives a usage-limit failure.
const CODEX_LIMIT_CODES: &[&str] = &[
    "usage_limit_reached",
    "quota_exceeded",
    "rate_limit_reached",
    "workspace_owner_usage_limit_reached",
    "workspace_member_usage_limit_reached",
];

fn codex_limit<Tz: TimeZone>(lower: &str, now: &DateTime<Tz>) -> Option<AgentLimit> {
    let sentence = limit_sentence(lower, &["you've hit your usage limit"]);
    if sentence.is_none() && !CODEX_LIMIT_CODES.iter().any(|c| lower.contains(c)) {
        return None;
    }
    // The reset sits on the limit's own line when there is one.
    let scope = sentence.unwrap_or(lower);
    let resets_at = if let Some(at) = scope.find("try again at ") {
        wall_clock(&scope[at + "try again at ".len()..], now)
    } else if let Some(at) = scope.find("try again in ") {
        duration_ms(&scope[at + "try again in ".len()..]).map(|ms| now.timestamp_millis() + ms)
    } else {
        None
    };
    Some(AgentLimit::limited(resets_at))
}

/// How the Gemini API (and so Gemini CLI) says a quota ran out.
const GEMINI_LIMIT_MARKERS: &[&str] = &[
    "resource_exhausted",
    "quota exceeded",
    "status 429",
    "code: 429",
    "\"code\":429",
    "\"code\": 429",
    "429 too many requests",
];

fn gemini_limit<Tz: TimeZone>(text: &str, lower: &str, now: &DateTime<Tz>) -> Option<AgentLimit> {
    if !GEMINI_LIMIT_MARKERS.iter().any(|m| lower.contains(m)) {
        return None;
    }
    let in_ms = if let Some(at) = lower.find("retry in ") {
        duration_ms(&lower[at + "retry in ".len()..])
    } else if let Some(at) = text.find("retryDelay") {
        // `"retryDelay":"23s"`, `"retryDelay": "23.5s"`.
        let rest = text[at + "retryDelay".len()..]
            .trim_start_matches(|c: char| c == '"' || c == ':' || c.is_whitespace());
        duration_ms(&rest.to_lowercase())
    } else {
        None
    };
    Some(AgentLimit::limited(
        in_ms.map(|ms| now.timestamp_millis() + ms),
    ))
}

/// The line of `lower` from the first of `openings` on, when it is about a
/// limit (`You've reached your …` alone could be about anything else).
fn limit_sentence<'a>(lower: &'a str, openings: &[&str]) -> Option<&'a str> {
    openings.iter().find_map(|opening| {
        let at = lower.find(opening)?;
        let line = lower[at..].lines().next().unwrap_or_default();
        ["limit", "usage", "credits"]
            .iter()
            .any(|w| line.contains(w))
            .then_some(line)
    })
}

/// A wall-clock time at the start of `s` (lowercase), as unix ms in `now`'s
/// zone: `6pm`, `6:30pm`, `6 pm`, `18:30`, `nov 20, 6pm`, `nov 20, 2026,
/// 6pm`, `nov 20, 2026 6:05 pm`. Words after it (a zone name, the rest of
/// the sentence) are left alone.
fn wall_clock<Tz: TimeZone>(s: &str, now: &DateTime<Tz>) -> Option<Millis> {
    let mut tokens = s
        .split(|c: char| c.is_whitespace() || c == ',')
        .map(|t| t.trim_end_matches(['.', ';', ')']))
        .filter(|t| !t.is_empty())
        .peekable();
    let mut date: Option<(u32, u32)> = None;
    let mut year: Option<i32> = None;
    if let Some(month) = tokens.peek().and_then(|t| month_of(t)) {
        tokens.next();
        let day = tokens.next()?.parse::<u32>().ok()?;
        date = Some((month, day));
        if let Some(y) = tokens
            .peek()
            .filter(|t| t.len() == 4)
            .and_then(|t| t.parse::<i32>().ok())
        {
            tokens.next();
            year = Some(y);
        }
    }
    let first = tokens.next()?;
    let (clock, mut meridiem) = split_meridiem(first);
    if meridiem.is_none() {
        meridiem = tokens.peek().and_then(|t| match *t {
            "am" | "a.m" => Some(false),
            "pm" | "p.m" => Some(true),
            _ => None,
        });
    }
    let (hour, minute) = match clock.split_once(':') {
        Some((h, m)) => (h.parse::<u32>().ok()?, m.parse::<u32>().ok()?),
        // A bare number is only a time with am/pm.
        None if meridiem.is_some() => (clock.parse::<u32>().ok()?, 0),
        None => return None,
    };
    let hour = match meridiem {
        Some(pm) if (1..=12).contains(&hour) => hour % 12 + if pm { 12 } else { 0 },
        Some(_) => return None,
        None if hour < 24 => hour,
        None => return None,
    };
    if minute > 59 {
        return None;
    }
    let tz = now.timezone();
    let today = now.date_naive();
    let at = |d: NaiveDate| {
        let t = d.and_hms_opt(hour, minute, 0)?;
        tz.from_local_datetime(&t).earliest()
    };
    let when = match date {
        Some((month, day)) => {
            let on = |y: i32| NaiveDate::from_ymd_opt(y, month, day).and_then(at);
            match year {
                Some(y) => on(y)?,
                None => {
                    let this_year = on(today.year())?;
                    // A date shown without its year is never long past.
                    if this_year < now.clone() - Duration::days(1) {
                        on(today.year() + 1)?
                    } else {
                        this_year
                    }
                }
            }
        }
        None => {
            let today_at = at(today)?;
            if today_at <= *now {
                at(today.succ_opt()?)?
            } else {
                today_at
            }
        }
    };
    Some(when.timestamp_millis())
}

/// `6pm` → (`6`, Some(pm)); `6:30` → (`6:30`, None).
fn split_meridiem(token: &str) -> (&str, Option<bool>) {
    if let Some(clock) = token.strip_suffix("pm") {
        (clock, Some(true))
    } else if let Some(clock) = token.strip_suffix("am") {
        (clock, Some(false))
    } else {
        (token, None)
    }
}

fn month_of(token: &str) -> Option<u32> {
    const MONTHS: [&str; 12] = [
        "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
    ];
    if token.len() < 3 || !token.chars().all(|c| c.is_ascii_alphabetic()) {
        return None;
    }
    MONTHS
        .iter()
        .position(|m| token.starts_with(m))
        .map(|i| i as u32 + 1)
}

/// A duration at the start of `s` (lowercase), in ms: `2 days 3 hours 5
/// minutes`, `3h 5m`, `23.5s`, `1 hour and 5 minutes`. `None` when no
/// number with a unit starts it.
fn duration_ms(s: &str) -> Option<Millis> {
    let mut total = 0.0;
    let mut any = false;
    let mut rest = s.trim_start();
    loop {
        let num_len = rest
            .find(|c: char| !(c.is_ascii_digit() || c == '.'))
            .unwrap_or(rest.len());
        if num_len == 0 {
            break;
        }
        let Ok(n) = rest[..num_len].trim_end_matches('.').parse::<f64>() else {
            break;
        };
        let after = rest[num_len..].trim_start();
        let unit_len = after
            .find(|c: char| !c.is_ascii_alphabetic())
            .unwrap_or(after.len());
        let secs = match &after[..unit_len] {
            "d" | "day" | "days" => 86_400.0,
            "h" | "hr" | "hrs" | "hour" | "hours" => 3_600.0,
            "m" | "min" | "mins" | "minute" | "minutes" => 60.0,
            "s" | "sec" | "secs" | "second" | "seconds" => 1.0,
            "ms" => 0.001,
            _ => break,
        };
        total += n * secs;
        any = true;
        rest = after[unit_len..].trim_start_matches([',', ' ']);
        rest = rest.strip_prefix("and ").unwrap_or(rest);
    }
    any.then_some((total * 1000.0).round() as Millis)
}

fn unix_secs_to_ms(v: &Value) -> Option<Millis> {
    v.as_i64()
        .or_else(|| v.as_f64().map(|f| f as i64))
        .map(|secs| secs * 1000)
}

fn keys_of(obj: &Map<String, Value>) -> Vec<&str> {
    obj.keys().map(String::as_str).collect()
}

fn json_kind(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "bool",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::FixedOffset;
    use serde_json::json;

    /// 2026-11-19 14:00 at UTC-8 (a fixed zone: tests never read the
    /// machine's).
    fn now() -> DateTime<FixedOffset> {
        FixedOffset::west_opt(8 * 3600)
            .unwrap()
            .with_ymd_and_hms(2026, 11, 19, 14, 0, 0)
            .unwrap()
    }

    fn at(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> Millis {
        FixedOffset::west_opt(8 * 3600)
            .unwrap()
            .with_ymd_and_hms(y, mo, d, h, mi, 0)
            .unwrap()
            .timestamp_millis()
    }

    fn limited(agent: AgentId, text: &str) -> Option<AgentLimit> {
        limit_in_error(agent, text, now())
    }

    fn reset(agent: AgentId, text: &str) -> Option<Millis> {
        limited(agent, text)
            .unwrap_or_else(|| panic!("not a limit: {text}"))
            .resets_at
    }

    // claude_rate_limit

    #[test]
    fn claude_allowed_is_ok_with_nothing_else() {
        assert_eq!(
            claude_rate_limit(&json!({"status": "allowed"})),
            Some(AgentLimit {
                status: LimitStatus::Ok,
                resets_at: None,
                window: None,
                used_pct: None,
            })
        );
    }

    #[test]
    fn claude_warning_carries_window_use_and_reset() {
        let limit = claude_rate_limit(&json!({
            "status": "allowed_warning",
            "resetsAt": 1_795_000_000,
            "rateLimitType": "seven_day",
            "utilization": 0.92,
            "isUsingOverage": false,
        }))
        .unwrap();
        assert_eq!(limit.status, LimitStatus::Warning);
        assert_eq!(limit.resets_at, Some(1_795_000_000_000));
        assert_eq!(limit.window.as_deref(), Some("seven_day"));
        assert!((limit.used_pct.unwrap() - 92.0).abs() < 1e-9);
    }

    #[test]
    fn claude_rejected_is_limited() {
        let limit = claude_rate_limit(&json!({
            "status": "rejected",
            "resetsAt": 1_795_000_000,
            "rateLimitType": "five_hour",
        }))
        .unwrap();
        assert_eq!(limit.status, LimitStatus::Limited);
        assert_eq!(limit.resets_at, Some(1_795_000_000_000));
        assert_eq!(limit.used_pct, None);
    }

    #[test]
    fn claude_without_top_level_use_takes_the_fullest_unified_window() {
        let limit = claude_rate_limit(&json!({
            "status": "allowed_warning",
            "unifiedWindows": {
                "five_hour": {"utilization": 0.4, "resetsAt": 1_000},
                "seven_day": {"utilization": 1.05, "resetsAt": 2_000, "status": "allowed_warning"},
            },
        }))
        .unwrap();
        assert!((limit.used_pct.unwrap() - 105.0).abs() < 1e-9);
        assert_eq!(limit.resets_at, Some(2_000_000));
        assert_eq!(limit.window.as_deref(), Some("seven_day"));
    }

    #[test]
    fn claude_top_level_reset_and_type_win_over_the_window() {
        let limit = claude_rate_limit(&json!({
            "status": "allowed",
            "resetsAt": 5,
            "rateLimitType": "five_hour",
            "unifiedWindows": {"seven_day": {"utilization": 0.5, "resetsAt": 9}},
        }))
        .unwrap();
        assert_eq!(limit.resets_at, Some(5_000));
        assert_eq!(limit.window.as_deref(), Some("five_hour"));
        assert!((limit.used_pct.unwrap() - 50.0).abs() < 1e-9);
    }

    #[test]
    fn claude_unknown_status_or_shape_is_none() {
        assert_eq!(claude_rate_limit(&json!({"status": "throttled"})), None);
        assert_eq!(claude_rate_limit(&json!({})), None);
        assert_eq!(claude_rate_limit(&json!("rejected")), None);
        assert_eq!(claude_rate_limit(&json!(null)), None);
    }

    // codex_rate_limits

    #[test]
    fn codex_takes_the_window_closest_to_its_limit() {
        let limit = codex_rate_limits_at(
            &json!({
                "primary": {"used_percent": 40.0, "window_minutes": 300, "resets_at": 100},
                "secondary": {"used_percent": 93.5, "window_minutes": 10080, "resets_in_seconds": 60},
            }),
            1_000,
        )
        .unwrap();
        assert_eq!(limit.status, LimitStatus::Warning);
        assert_eq!(limit.window.as_deref(), Some("seven_day"));
        assert_eq!(limit.used_pct, Some(93.5));
        assert_eq!(limit.resets_at, Some(61_000));
    }

    #[test]
    fn codex_full_window_is_limited_and_low_one_ok() {
        let full = codex_rate_limits_at(
            &json!({"primary": {"used_percent": 100.0, "window_minutes": 300, "resets_at": 7}}),
            0,
        )
        .unwrap();
        assert_eq!(full.status, LimitStatus::Limited);
        assert_eq!(full.window.as_deref(), Some("five_hour"));
        assert_eq!(full.resets_at, Some(7_000));
        let low = codex_rate_limits_at(&json!({"primary": {"used_percent": 3}}), 0).unwrap();
        assert_eq!(low.status, LimitStatus::Ok);
        assert_eq!(low.window.as_deref(), Some("primary"));
        assert_eq!(low.resets_at, None);
    }

    #[test]
    fn codex_without_windows_is_none() {
        assert_eq!(codex_rate_limits_at(&json!({}), 0), None);
        assert_eq!(codex_rate_limits_at(&json!([1]), 0), None);
        assert_eq!(
            codex_rate_limits_at(&json!({"primary": {"window_minutes": 300}}), 0),
            None
        );
    }

    // limit_in_error: Claude

    #[test]
    fn claude_session_limit_resets_later_today() {
        assert_eq!(
            reset(
                AgentId::Claude,
                "You've hit your session limit · resets 6pm"
            ),
            Some(at(2026, 11, 19, 18, 0))
        );
    }

    #[test]
    fn claude_time_already_past_today_is_tomorrow() {
        assert_eq!(
            reset(
                AgentId::Claude,
                "You've hit your session limit · resets 9am"
            ),
            Some(at(2026, 11, 20, 9, 0))
        );
        assert_eq!(
            reset(AgentId::Claude, "You've hit your limit · resets 2pm"),
            Some(at(2026, 11, 20, 14, 0))
        );
    }

    #[test]
    fn claude_minutes_and_a_zone_name() {
        assert_eq!(
            reset(
                AgentId::Claude,
                "You've hit your limit · resets 6:30pm (Europe/Berlin)"
            ),
            Some(at(2026, 11, 19, 18, 30))
        );
        assert_eq!(
            reset(AgentId::Claude, "You've hit your limit · resets 12am"),
            Some(at(2026, 11, 20, 0, 0))
        );
        assert_eq!(
            reset(AgentId::Claude, "You've hit your limit · resets 12:15pm"),
            Some(at(2026, 11, 20, 12, 15))
        );
    }

    #[test]
    fn claude_weekly_limit_with_a_date() {
        assert_eq!(
            reset(
                AgentId::Claude,
                "You've hit your weekly limit · resets Nov 20, 6pm"
            ),
            Some(at(2026, 11, 20, 18, 0))
        );
        assert_eq!(
            reset(
                AgentId::Claude,
                "You've reached your Opus limit · resets Nov 25, 6:30pm (America/Los_Angeles)"
            ),
            Some(at(2026, 11, 25, 18, 30))
        );
    }

    #[test]
    fn claude_date_across_the_new_year() {
        assert_eq!(
            reset(
                AgentId::Claude,
                "You've hit your weekly limit · resets Jan 2, 6pm"
            ),
            Some(at(2027, 1, 2, 18, 0))
        );
        assert_eq!(
            reset(
                AgentId::Claude,
                "You've hit your weekly limit · resets Jan 2, 2027, 6pm"
            ),
            Some(at(2027, 1, 2, 18, 0))
        );
    }

    #[test]
    fn claude_out_of_credits_has_no_reset() {
        for text in [
            "You're out of usage credits",
            "Your org is out of usage credits for this month",
            "You've hit your limit",
            "You\u{2019}ve hit your session limit",
        ] {
            assert_eq!(
                limited(AgentId::Claude, text),
                Some(AgentLimit::limited(None)),
                "{text}"
            );
        }
    }

    #[test]
    fn claude_legacy_pipe_carries_unix_seconds() {
        assert_eq!(
            reset(AgentId::Claude, "Claude AI usage limit reached|1731960000"),
            Some(1_731_960_000_000)
        );
        assert_eq!(
            limited(AgentId::Claude, "Claude AI usage limit reached"),
            Some(AgentLimit::limited(None))
        );
    }

    #[test]
    fn claude_found_inside_a_longer_error() {
        assert_eq!(
            reset(
                AgentId::Claude,
                "Error: request failed\nYou've hit your session limit · resets 6pm\nmore"
            ),
            Some(at(2026, 11, 19, 18, 0))
        );
    }

    #[test]
    fn claude_other_errors_are_not_limits() {
        for text in [
            r#"API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of requests has exceeded your per-minute rate limit"}}"#,
            "You've reached your destination",
            "claude exited with a non-zero status",
            "RESOURCE_EXHAUSTED",
            "",
        ] {
            assert_eq!(limited(AgentId::Claude, text), None, "{text}");
        }
    }

    // limit_in_error: Codex

    #[test]
    fn codex_usage_limit_with_a_full_date() {
        assert_eq!(
            reset(
                AgentId::Codex,
                "You\u{2019}ve hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at Nov 20, 2026 6:05 PM."
            ),
            Some(at(2026, 11, 20, 18, 5))
        );
        assert_eq!(
            reset(
                AgentId::Codex,
                "You've hit your usage limit. Try again at Nov 21, 2026 9:00 AM."
            ),
            Some(at(2026, 11, 21, 9, 0))
        );
    }

    #[test]
    fn codex_usage_limit_with_a_time_only() {
        assert_eq!(
            reset(
                AgentId::Codex,
                "You\u{2019}ve hit your usage limit. Try again at 6:05 PM."
            ),
            Some(at(2026, 11, 19, 18, 5))
        );
        assert_eq!(
            reset(
                AgentId::Codex,
                "You\u{2019}ve hit your usage limit. Try again at 1:05 PM."
            ),
            Some(at(2026, 11, 20, 13, 5))
        );
    }

    #[test]
    fn codex_usage_limit_in_a_duration() {
        let base = now().timestamp_millis();
        assert_eq!(
            reset(
                AgentId::Codex,
                "You've hit your usage limit. Try again in 2 days 3 hours 5 minutes."
            ),
            Some(base + ((2 * 24 + 3) * 3600 + 5 * 60) * 1000)
        );
        assert_eq!(
            reset(
                AgentId::Codex,
                "You've hit your usage limit, try again in 3h 5m"
            ),
            Some(base + (3 * 3600 + 5 * 60) * 1000)
        );
    }

    #[test]
    fn codex_usage_limit_without_a_reset() {
        for text in [
            "You\u{2019}ve hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits",
            "You\u{2019}ve hit your usage limit for gpt-5-codex. Switch to another model now, or try later.",
            r#"{"error":{"type":"usage_limit_reached","message":"limit"}}"#,
            "quota_exceeded",
            "rate_limit_reached",
            "workspace_owner_usage_limit_reached",
            "workspace_member_usage_limit_reached",
        ] {
            assert_eq!(
                limited(AgentId::Codex, text),
                Some(AgentLimit::limited(None)),
                "{text}"
            );
        }
    }

    #[test]
    fn codex_other_errors_are_not_limits() {
        for text in [
            "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header",
            "stream disconnected before completion",
            "codex turn failed",
        ] {
            assert_eq!(limited(AgentId::Codex, text), None, "{text}");
        }
    }

    // limit_in_error: Gemini

    #[test]
    fn gemini_resource_exhausted_with_a_retry() {
        let base = now().timestamp_millis();
        assert_eq!(
            reset(
                AgentId::Gemini,
                "[API Error: You exceeded your current quota. Please retry in 23.5s. RESOURCE_EXHAUSTED]"
            ),
            Some(base + 23_500)
        );
        assert_eq!(
            reset(
                AgentId::Gemini,
                r#"{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"23s"}]}}"#
            ),
            Some(base + 23_000)
        );
    }

    #[test]
    fn gemini_quota_markers_without_a_reset() {
        for text in [
            "RESOURCE_EXHAUSTED",
            "Quota exceeded for quota metric 'Generate Content API requests per day'",
            "got status 429",
            "error code: 429",
            "429 Too Many Requests",
            r#"{"code": 429}"#,
        ] {
            assert_eq!(
                limited(AgentId::Gemini, text),
                Some(AgentLimit::limited(None)),
                "{text}"
            );
        }
    }

    #[test]
    fn gemini_other_errors_are_not_limits() {
        assert_eq!(limited(AgentId::Gemini, "Please set an Auth method"), None);
        assert_eq!(limited(AgentId::Gemini, "status 500"), None);
    }

    // helpers

    #[test]
    fn durations_read_every_unit() {
        assert_eq!(duration_ms("23.5s"), Some(23_500));
        assert_eq!(duration_ms("1 hour and 5 minutes"), Some(3_900_000));
        assert_eq!(duration_ms("2d"), Some(172_800_000));
        assert_eq!(duration_ms("soon"), None);
        assert_eq!(duration_ms("5 apples"), None);
    }

    #[test]
    fn wall_clock_needs_a_time() {
        assert_eq!(wall_clock("6", &now()), None);
        assert_eq!(wall_clock("nov 20", &now()), None);
        assert_eq!(wall_clock("13pm", &now()), None);
        assert_eq!(wall_clock("18:30", &now()), Some(at(2026, 11, 19, 18, 30)));
        assert_eq!(wall_clock("6 pm", &now()), Some(at(2026, 11, 19, 18, 0)));
    }
}
