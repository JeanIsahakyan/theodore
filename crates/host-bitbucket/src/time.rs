//! Minimal ISO 8601 -> unix millis, with no date-time dependency. Bitbucket's
//! REST timestamps carry microsecond fractions and an explicit UTC offset
//! (`2024-01-15T10:00:00.123456+00:00`), rather than GitHub/GitLab's bare `Z`
//! suffix, so the offset is parsed (and applied) instead of assumed away.

pub(crate) fn parse_millis(s: &str) -> i64 {
    try_parse(s).unwrap_or(0)
}

fn try_parse(s: &str) -> Option<i64> {
    let (body, offset_minutes) = split_offset(s)?;
    let (date, time) = body.split_once('T')?;

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
    let utc_ms = days * 86_400_000 + hour * 3_600_000 + min * 60_000 + sec * 1000 + millis_frac;
    Some(utc_ms - offset_minutes * 60_000)
}

/// Splits the trailing `Z` or `+HH:MM`/`-HH:MM` offset off, returning the
/// naive body and the offset in minutes (east of UTC, `Z` is `0`).
fn split_offset(s: &str) -> Option<(&str, i64)> {
    if let Some(body) = s.strip_suffix('Z') {
        return Some((body, 0));
    }
    // The offset's sign is the last `+`/`-` at or after index 10 (past the
    // date's own `-`-separated fields), so a `-`-only date never misleads
    // this.
    let sign_pos = s.get(10..)?.rfind(['+', '-'])? + 10;
    let (body, offset) = s.split_at(sign_pos);
    let sign: i64 = if offset.starts_with('-') { -1 } else { 1 };
    let offset = &offset[1..];
    let (oh, om) = offset.split_once(':').unwrap_or((offset, "0"));
    let minutes = sign * (oh.parse::<i64>().ok()? * 60 + om.parse::<i64>().unwrap_or(0));
    Some((body, minutes))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn epoch_with_z_suffix_is_zero() {
        assert_eq!(parse_millis("1970-01-01T00:00:00Z"), 0);
    }

    #[test]
    fn utc_offset_matches_z() {
        assert_eq!(
            parse_millis("1970-01-01T00:00:00.000000+00:00"),
            parse_millis("1970-01-01T00:00:00Z"),
        );
    }

    #[test]
    fn positive_offset_subtracts() {
        // 01:00 at +01:00 is 00:00 UTC.
        assert_eq!(parse_millis("1970-01-01T01:00:00+01:00"), 0);
    }

    #[test]
    fn negative_offset_adds() {
        // 23:00 the day before at -01:00 is 00:00 UTC the next day.
        assert_eq!(parse_millis("1969-12-31T23:00:00-01:00"), 0);
    }

    #[test]
    fn microsecond_fraction_truncates_to_millis() {
        assert_eq!(parse_millis("1970-01-01T00:00:00.123456+00:00"), 123);
    }

    #[test]
    fn known_timestamp() {
        assert_eq!(
            parse_millis("2020-01-01T00:00:00.000000+00:00"),
            1_577_836_800_000
        );
    }

    #[test]
    fn malformed_input_falls_back_to_zero() {
        assert_eq!(parse_millis("not a date"), 0);
    }
}
