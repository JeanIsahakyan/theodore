//! Minimal RFC 3339 (`Z`-suffixed UTC) millis <-> string, with no date-time
//! dependency. GitLab's REST timestamps are always UTC with a `Z` suffix;
//! `format_millis` is the inverse, used to mint the `updated_after` cursor
//! for `changed_since` (plan §6.6).

pub(crate) fn parse_millis(s: &str) -> i64 {
    try_parse(s).unwrap_or(0)
}

fn try_parse(s: &str) -> Option<i64> {
    let s = s.strip_suffix('Z')?;
    let (date, time) = s.split_once('T')?;

    let mut d = date.split('-');
    let year: i64 = d.next()?.parse().ok()?;
    let month: i64 = d.next()?.parse().ok()?;
    let day: i64 = d.next()?.parse().ok()?;

    let (time, frac) = time.split_once('.').unwrap_or((time, ""));
    let mut t = time.split(':');
    let hour: i64 = t.next()?.parse().ok()?;
    let min: i64 = t.next()?.parse().ok()?;
    let sec: i64 = t.next()?.parse().ok()?;
    let millis_frac: i64 = if frac.is_empty() {
        0
    } else {
        let padded = format!("{:0<3}", &frac[..frac.len().min(3)]);
        padded.parse().ok()?
    };

    let days = days_from_civil(year, month, day);
    Some(days * 86_400_000 + hour * 3_600_000 + min * 60_000 + sec * 1000 + millis_frac)
}

/// Howard Hinnant's `days_from_civil`: days since the unix epoch for a
/// proleptic-Gregorian civil date.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Inverse of `days_from_civil` (same source): the civil date for a count of
/// days since the unix epoch.
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Unix millis -> `YYYY-MM-DDTHH:MM:SS.sssZ`.
pub(crate) fn format_millis(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let rem_ms = ms.rem_euclid(86_400_000);
    let (y, m, d) = civil_from_days(days);
    let hour = rem_ms / 3_600_000;
    let min = (rem_ms % 3_600_000) / 60_000;
    let sec = (rem_ms % 60_000) / 1000;
    let millis = rem_ms % 1000;
    format!("{y:04}-{m:02}-{d:02}T{hour:02}:{min:02}:{sec:02}.{millis:03}Z")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn epoch_is_zero() {
        assert_eq!(parse_millis("1970-01-01T00:00:00Z"), 0);
    }

    #[test]
    fn known_unix_seconds() {
        assert_eq!(parse_millis("2020-01-01T00:00:00Z"), 1_577_836_800_000);
    }

    #[test]
    fn fractional_seconds_are_kept() {
        assert_eq!(parse_millis("1970-01-01T00:00:00.5Z"), 500);
        assert_eq!(parse_millis("1970-01-01T00:00:00.123Z"), 123);
    }

    #[test]
    fn malformed_input_falls_back_to_zero() {
        assert_eq!(parse_millis("not a date"), 0);
    }

    #[test]
    fn format_round_trips_through_parse() {
        for ms in [0, 1_577_836_800_000, 1_700_000_000_000, 12_345_678_000] {
            assert_eq!(parse_millis(&format_millis(ms)), ms, "round trip for {ms}");
        }
    }

    #[test]
    fn format_matches_known_timestamp() {
        assert_eq!(format_millis(1_577_836_800_000), "2020-01-01T00:00:00.000Z");
    }
}
