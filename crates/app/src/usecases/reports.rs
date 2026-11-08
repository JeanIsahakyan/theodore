//! "My reports" (docs/telemetry.md): the issues "Report a problem" opened
//! from this install, followed until the fix ships.
//!
//! ```text
//! submit_issue ─▶ #N created ─▶ track_report ─▶ `report` row (open)
//!
//! poller, 20 s after start, then every 30 min (online, signed in):
//!   each followed row ─▶ issue_status ─▶ state, close reason, comments, closer
//!        closed as fixed, closer has a commit ─▶ first_release_with ─▶ released
//!        changed ─▶ row written (synced) ─▶ ReportUpdate (toast, notification)
//!   released in the running version, not said yet ─▶ "fixed in this version"
//! ```
//!
//! Followed: open ones; closed ones for 30 days after closing; a fix not in
//! a release yet for 180.

use std::cmp::Ordering;
use std::sync::Arc;

use theodore_contract::{Ephemeral, ReportStatus, TrackedReport, models};
use theodore_ports::{IssueStatus, IssueTracker, NewAction, SyncActionCode};

use crate::core::Core;
use crate::error::{AppError, AppResult};

/// The first check after start: soon, but after the window is listening.
pub(crate) const REPORTS_FIRST_MS: i64 = 20_000;
/// Then every 30 minutes.
pub(crate) const REPORTS_POLL_MS: i64 = 30 * 60_000;

const DAY_MS: i64 = 24 * 60 * 60_000;
/// A closed report (not planned, released, fixed with no commit to look
/// for) is followed this long after closing: replies still come.
const FOLLOW_CLOSED_MS: i64 = 30 * DAY_MS;
/// A fix with a commit but no release yet is followed this long.
const FOLLOW_UNRELEASED_MS: i64 = 180 * DAY_MS;

/// What the core follows reports with; set once by the shell.
#[derive(Clone)]
pub(crate) struct ReportsFollow {
    tracker: Arc<dyn IssueTracker>,
    /// The running app's version (`0.1.14`).
    version: String,
}

/// The row id: `owner/name#number`.
pub(crate) fn report_id(repo: &str, number: u64) -> String {
    format!("{repo}#{number}")
}

impl Core {
    /// Follows report issues with `tracker` (real runs only: sandbox and
    /// fixture runs have none, so nothing is followed). `version` is the
    /// running app's, for "fixed in this version".
    pub fn follow_reports(&self, tracker: Option<Arc<dyn IssueTracker>>, version: &str) {
        *self.0.reports.lock().unwrap_or_else(|p| p.into_inner()) =
            tracker.map(|tracker| ReportsFollow {
                tracker,
                version: version.trim_start_matches('v').to_string(),
            });
    }

    /// Remembers an issue "Report a problem" just opened in `repo`
    /// (`owner/name`), so "My reports" lists and follows it.
    pub async fn track_report(
        &self,
        repo: &str,
        number: u64,
        url: &str,
        title: &str,
    ) -> AppResult<()> {
        let now = self.0.deps.clock.now();
        let row = TrackedReport {
            repo: repo.to_string(),
            number,
            url: url.to_string(),
            title: title.to_string(),
            status: ReportStatus::Open,
            filed_at: now,
            updated_at: now,
            comments: 0,
            close_reason: None,
            closed_at: None,
            fixed_by: None,
            fixed_by_url: None,
            fix_sha: None,
            released_in: None,
            author: None,
            told_in: None,
        };
        self.write_report(&row).await
    }

    async fn write_report(&self, row: &TrackedReport) -> AppResult<()> {
        let data = serde_json::to_value(row).map_err(|e| AppError::Invalid(e.to_string()))?;
        self.apply(vec![NewAction {
            model: models::REPORT.into(),
            model_id: report_id(&row.repo, row.number),
            action: SyncActionCode::U,
            data: Some(data),
        }])
        .await?;
        Ok(())
    }

    /// One pass over the followed reports (the poller's, every 30 min).
    pub(crate) async fn check_reports(&self) {
        let Some(follow) = self
            .0
            .reports
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
        else {
            return;
        };
        let store = self.0.deps.store.clone();
        let Ok(Ok(rows)) = tokio::task::spawn_blocking(move || store.all(models::REPORT)).await
        else {
            return;
        };
        let mut reports: Vec<TrackedReport> = rows
            .into_iter()
            .filter(|r| !r.archived)
            .filter_map(|r| serde_json::from_value(r.data).ok())
            .collect();
        reports.sort_by_key(|r| r.filed_at);
        // Offline: no host calls, but what needs none ("fixed in this
        // version" after an update) is still said.
        let mut online = self.host_online();
        for before in reports {
            let mut after = before.clone();
            let mut reply = false;
            if online && followed(&before, self.0.deps.clock.now()) {
                match self.refresh_report(&follow, &mut after).await {
                    Ok(r) => reply = r,
                    Err(e) if Core::is_connection_error(&e) => {
                        tracing::debug!(error = %e, "reports: GitHub unreachable, later");
                        online = false;
                    }
                    // Not a blip: a check that keeps failing (a query the
                    // host refuses) must show in the normal log.
                    Err(e) => {
                        tracing::warn!(number = before.number, error = %e, "report not checked")
                    }
                }
            }
            let text = notice(&before, &after, reply, &follow.version);
            if after.status == ReportStatus::Released
                && after
                    .released_in
                    .as_deref()
                    .is_some_and(|v| compare_versions(v, &follow.version).is_some())
            {
                // Said or not needed from here on: never again for this version.
                after.told_in = Some(follow.version.clone());
            }
            if after != before {
                if after.status != before.status {
                    tracing::info!(
                        number = after.number,
                        status = ?after.status,
                        "report changed"
                    );
                }
                if let Err(e) = self.write_report(&after).await {
                    tracing::warn!(error = %e, "report not saved");
                    continue;
                }
            }
            if let Some(text) = text {
                self.emit(Ephemeral::ReportUpdate {
                    number: after.number,
                    url: after.url.clone(),
                    title: after.title.clone(),
                    text,
                });
            }
        }
    }

    /// Reads the issue and, for a fix not released yet, the release that
    /// has it. `true` when someone other than the reporter replied.
    async fn refresh_report(
        &self,
        follow: &ReportsFollow,
        row: &mut TrackedReport,
    ) -> theodore_ports::HostResult<bool> {
        let Some((owner, name)) = row
            .repo
            .clone()
            .split_once('/')
            .map(|(o, n)| (o.to_string(), n.to_string()))
        else {
            return Ok(false);
        };
        let status = follow
            .tracker
            .issue_status(&owner, &name, row.number)
            .await?;
        let reply = merge_status(row, &status);
        if row.status == ReportStatus::Fixed
            && let Some(sha) = row.fix_sha.clone()
            && let Some(tag) = follow
                .tracker
                .first_release_with(&owner, &name, &sha)
                .await?
        {
            row.released_in = Some(tag.trim_start_matches('v').to_string());
            row.status = ReportStatus::Released;
        }
        Ok(reply)
    }
}

/// Whether `r` is still worth asking GitHub about at `now`.
fn followed(r: &TrackedReport, now: i64) -> bool {
    let Some(closed_at) = r.closed_at.filter(|_| r.status != ReportStatus::Open) else {
        return true;
    };
    let waits_for_release = r.status == ReportStatus::Fixed && r.fix_sha.is_some();
    let limit = if waits_for_release {
        FOLLOW_UNRELEASED_MS
    } else {
        FOLLOW_CLOSED_MS
    };
    now - closed_at < limit
}

/// Folds GitHub's answer into `row`; `true` when it has a new comment by
/// someone other than the reporter.
fn merge_status(row: &mut TrackedReport, s: &IssueStatus) -> bool {
    let author = s.author.clone().or_else(|| row.author.clone());
    let reply = s.comments > row.comments
        && s.last_commenter.is_some()
        && s.last_commenter.as_deref() != author.as_deref();
    row.title = s.title.clone();
    row.url = s.url.clone();
    row.updated_at = s.updated_at.max(row.filed_at);
    row.comments = s.comments;
    row.author = author;
    if s.open {
        row.status = ReportStatus::Open;
        row.close_reason = None;
        row.closed_at = None;
        row.fixed_by = None;
        row.fixed_by_url = None;
        row.fix_sha = None;
        row.released_in = None;
        return reply;
    }
    row.closed_at = s.closed_at;
    row.close_reason = s.close_reason.clone();
    if matches!(s.close_reason.as_deref(), Some("not_planned" | "duplicate")) {
        row.status = ReportStatus::NotPlanned;
        row.fixed_by = None;
        row.fixed_by_url = None;
        row.fix_sha = None;
        row.released_in = None;
        return reply;
    }
    let closer = s.closed_by.as_ref();
    let sha = closer.and_then(|c| c.sha.clone());
    let same_fix = row.status == ReportStatus::Released && row.fix_sha == sha;
    row.fixed_by = closer.and_then(|c| c.pr);
    row.fixed_by_url = closer.and_then(|c| c.pr_url.clone());
    row.fix_sha = sha;
    if !same_fix {
        row.status = ReportStatus::Fixed;
        row.released_in = None;
    }
    reply
}

/// What to say about `before` → `after`, if anything: a state change
/// first, else a reply, else "fixed in this version" once after an update.
fn notice(
    before: &TrackedReport,
    after: &TrackedReport,
    reply: bool,
    version: &str,
) -> Option<String> {
    let n = after.number;
    let changed = (before.status != after.status).then(|| match after.status {
        ReportStatus::Open => format!("Your report #{n} was reopened"),
        ReportStatus::NotPlanned if after.close_reason.as_deref() == Some("duplicate") => {
            format!("Your report #{n} was closed as a duplicate")
        }
        ReportStatus::NotPlanned => format!("Your report #{n} was closed as not planned"),
        ReportStatus::Fixed => match after.fixed_by {
            Some(pr) => format!("Your report #{n} is fixed in #{pr}"),
            None => format!("Your report #{n} was closed as fixed"),
        },
        ReportStatus::Released => released_text(n, after.released_in.as_deref(), version),
    });
    if changed.is_some() {
        return changed;
    }
    if reply {
        return Some(format!("New reply on your report #{n}"));
    }
    let untold = after.status == ReportStatus::Released
        && after.told_in.as_deref() != Some(version)
        && after
            .released_in
            .as_deref()
            .and_then(|v| compare_versions(v, version))
            == Some(Ordering::Equal);
    untold.then(|| format!("Your report #{n} is fixed in this version"))
}

fn released_text(n: u64, released_in: Option<&str>, version: &str) -> String {
    let Some(v) = released_in else {
        return format!("Your report #{n} is fixed");
    };
    match compare_versions(v, version) {
        Some(Ordering::Equal) => format!("Your report #{n} is fixed in this version"),
        Some(Ordering::Less) => format!("Your report #{n} was fixed in {v}: you have it"),
        _ => format!("Your report #{n} is fixed in {v}: update to get it"),
    }
}

/// `a` against `b` as dotted numbers (`0.1.7` < `0.1.14`), a pre-release
/// or build suffix ignored; `None` when either isn't a version.
fn compare_versions(a: &str, b: &str) -> Option<Ordering> {
    fn parts(v: &str) -> Option<Vec<u64>> {
        let core = v
            .trim_start_matches('v')
            .split(['-', '+'])
            .next()
            .unwrap_or("");
        core.split('.').map(|p| p.parse().ok()).collect()
    }
    let (a, b) = (parts(a)?, parts(b)?);
    Some(a.cmp(&b))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_compare_numerically() {
        assert_eq!(compare_versions("0.1.7", "0.1.14"), Some(Ordering::Less));
        assert_eq!(compare_versions("v0.1.14", "0.1.14"), Some(Ordering::Equal));
        assert_eq!(
            compare_versions("0.2.0-beta.1", "0.1.9"),
            Some(Ordering::Greater)
        );
        assert_eq!(compare_versions("dev", "0.1.0"), None);
    }

    fn row(status: ReportStatus) -> TrackedReport {
        TrackedReport {
            repo: "acme/theodore".into(),
            number: 42,
            url: "u".into(),
            title: "t".into(),
            status,
            filed_at: 0,
            updated_at: 0,
            comments: 0,
            close_reason: None,
            closed_at: None,
            fixed_by: None,
            fixed_by_url: None,
            fix_sha: None,
            released_in: None,
            author: None,
            told_in: None,
        }
    }

    #[test]
    fn closed_reports_stop_being_followed() {
        let mut r = row(ReportStatus::NotPlanned);
        r.closed_at = Some(0);
        assert!(followed(&r, DAY_MS));
        assert!(!followed(&r, FOLLOW_CLOSED_MS));
        r.status = ReportStatus::Fixed;
        r.fix_sha = Some("abc".into());
        assert!(followed(&r, FOLLOW_CLOSED_MS));
        assert!(!followed(&r, FOLLOW_UNRELEASED_MS));
        assert!(followed(&row(ReportStatus::Open), FOLLOW_UNRELEASED_MS * 2));
    }

    #[test]
    fn released_text_depends_on_the_running_version() {
        assert_eq!(
            released_text(42, Some("0.1.7"), "0.1.6"),
            "Your report #42 is fixed in 0.1.7: update to get it"
        );
        assert_eq!(
            released_text(42, Some("0.1.7"), "0.1.7"),
            "Your report #42 is fixed in this version"
        );
        assert_eq!(
            released_text(42, Some("0.1.7"), "0.1.9"),
            "Your report #42 was fixed in 0.1.7: you have it"
        );
    }

    #[test]
    fn fixed_in_this_version_is_said_once_after_an_update() {
        let mut r = row(ReportStatus::Released);
        r.released_in = Some("0.1.7".into());
        r.told_in = Some("0.1.6".into());
        assert_eq!(
            notice(&r, &r, false, "0.1.7").as_deref(),
            Some("Your report #42 is fixed in this version")
        );
        r.told_in = Some("0.1.7".into());
        assert_eq!(notice(&r, &r, false, "0.1.7"), None);
    }
}
