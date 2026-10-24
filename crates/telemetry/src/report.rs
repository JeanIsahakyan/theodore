//! "Report a problem": a zip of the newest logs (redacted again for
//! sharing: repository names and paths hashed) plus app info, built in a
//! temp folder for the user to review. Nothing is uploaded.
//!
//! ```text
//! <tmp>/theodore-reports/theodore-report-<stamp>/
//!     app-info.json
//!     logs/theodore.jsonl, logs/theodore-<older>.jsonl …   (newest first, ≤ max_log_bytes)
//! <tmp>/theodore-reports/theodore-report-<stamp>.zip
//! ```

use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

use serde_json::Value;
use theodore_contract::{ProblemReport, ReportFile};

use crate::file::{FILE_NAME, rotated_files};
use crate::record::Record;
use crate::redact::Redactor;

/// How much of the log goes into a report.
pub const MAX_LOG_BYTES: u64 = 20 * 1024 * 1024;

pub fn reports_dir() -> PathBuf {
    std::env::temp_dir().join("theodore-reports")
}

/// Whether `path` is inside the reports folder (`reveal_report` shows
/// nothing else).
pub fn is_report_path(path: &Path) -> bool {
    let (Ok(p), Ok(root)) = (path.canonicalize(), reports_dir().canonicalize()) else {
        return false;
    };
    p.starts_with(root)
}

pub struct ReportInput<'a> {
    pub logs_dir: &'a Path,
    /// `app-info.json`: version, commit, OS, agent CLIs.
    pub app_info: serde_json::Map<String, Value>,
    /// One line each, for "Copy summary".
    pub summary: Vec<String>,
    pub max_log_bytes: u64,
    pub redactor: &'a Redactor,
}

/// The log files, newest first, as many as fit in `max` bytes (the oldest
/// one that doesn't fit is left out).
fn pick_logs(dir: &Path, max: u64) -> Vec<(PathBuf, u64)> {
    let mut all: Vec<(PathBuf, u64)> = Vec::new();
    let current = dir.join(FILE_NAME);
    if let Ok(m) = std::fs::metadata(&current) {
        all.push((current, m.len()));
    }
    let mut rotated = rotated_files(dir);
    rotated.reverse();
    all.extend(rotated);
    let mut total = 0;
    all.into_iter()
        .take_while(|(_, n)| {
            total += n;
            total <= max || total == *n
        })
        .collect()
}

/// Re-redacts one JSON log line for sharing.
fn share_line(redactor: &Redactor, line: &str) -> Option<String> {
    let Ok(Value::Object(obj)) = serde_json::from_str::<Value>(line) else {
        // Not ours (a torn last line): left out rather than shared raw.
        return None;
    };
    let mut rec = Record::new(tracing::Level::INFO, "", "");
    rec.fields = obj;
    let msg = rec
        .fields
        .remove("msg")
        .and_then(|m| m.as_str().map(str::to_string));
    let mut out = redactor.remote(&rec).fields;
    if let Some(m) = msg {
        out.insert("msg".into(), Value::String(redactor.remote_text(&m)));
    }
    Some(Value::Object(out).to_string())
}

pub fn build(input: ReportInput<'_>, root: &Path) -> std::io::Result<ProblemReport> {
    let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S").to_string();
    let name = format!("theodore-report-{stamp}");
    let dir = root.join(&name);
    let logs_out = dir.join("logs");
    std::fs::create_dir_all(&logs_out)?;

    let mut files = Vec::new();
    let info = serde_json::to_string_pretty(&Value::Object(input.app_info))?;
    std::fs::write(dir.join("app-info.json"), &info)?;
    files.push(ReportFile {
        name: "app-info.json".into(),
        bytes: info.len() as u64,
    });

    for (path, _) in pick_logs(input.logs_dir, input.max_log_bytes) {
        let Some(file_name) = path.file_name() else {
            continue;
        };
        let target = logs_out.join(file_name);
        let reader = std::io::BufReader::new(std::fs::File::open(&path)?);
        let mut out = std::io::BufWriter::new(std::fs::File::create(&target)?);
        for line in reader.lines().map_while(Result::ok) {
            if let Some(l) = share_line(input.redactor, &line) {
                writeln!(out, "{l}")?;
            }
        }
        out.flush()?;
        drop(out);
        files.push(ReportFile {
            name: format!("logs/{}", file_name.to_string_lossy()),
            bytes: std::fs::metadata(&target)?.len(),
        });
    }

    let zip_path = root.join(format!("{name}.zip"));
    zip_dir(&dir, &files, &zip_path)?;

    let mut summary = input.summary;
    summary.push(format!(
        "Report: {} ({} files)",
        zip_path.display(),
        files.len()
    ));
    Ok(ProblemReport {
        path: zip_path.display().to_string(),
        dir: dir.display().to_string(),
        files,
        summary: summary.join("\n"),
    })
}

fn zip_dir(dir: &Path, files: &[ReportFile], out: &Path) -> std::io::Result<()> {
    let mut zip = zip::ZipWriter::new(std::fs::File::create(out)?);
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for f in files {
        zip.start_file(&f.name, opts)
            .map_err(std::io::Error::other)?;
        let mut src = std::fs::File::open(dir.join(&f.name))?;
        std::io::copy(&mut src, &mut zip)?;
    }
    zip.finish().map_err(std::io::Error::other)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_report_holds_app_info_and_logs_redacted_for_sharing() {
        let logs = tempfile::tempdir().unwrap();
        let out = tempfile::tempdir().unwrap();
        let line = Record::new(
            tracing::Level::WARN,
            "theodore_app",
            "push to github.com/acme/app failed",
        )
        .with_field("repo", "acme/app")
        .with_field("error.code", "git.command_failed")
        .to_line();
        std::fs::write(logs.path().join(FILE_NAME), format!("{line}\nnot json\n")).unwrap();
        std::fs::write(
            logs.path().join("theodore-20261001-000000000.jsonl"),
            format!("{line}\n"),
        )
        .unwrap();

        let redactor = Redactor::new(None, "s");
        let mut info = serde_json::Map::new();
        info.insert("version".into(), "1.0.0".into());
        let report = build(
            ReportInput {
                logs_dir: logs.path(),
                app_info: info,
                summary: vec!["Theodore 1.0.0".into()],
                max_log_bytes: MAX_LOG_BYTES,
                redactor: &redactor,
            },
            out.path(),
        )
        .unwrap();

        let names: Vec<&str> = report.files.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(
            names,
            [
                "app-info.json",
                "logs/theodore.jsonl",
                "logs/theodore-20261001-000000000.jsonl"
            ]
        );
        assert!(report.summary.starts_with("Theodore 1.0.0\nReport: "));
        let shared =
            std::fs::read_to_string(Path::new(&report.dir).join("logs/theodore.jsonl")).unwrap();
        assert_eq!(shared.lines().count(), 1, "the torn line is left out");
        assert!(!shared.contains("acme"), "{shared}");
        assert!(shared.contains("git.command_failed"));

        let zip = zip::ZipArchive::new(std::fs::File::open(&report.path).unwrap()).unwrap();
        assert_eq!(zip.len(), 3);
    }

    #[test]
    fn only_the_newest_logs_that_fit_are_taken() {
        let logs = tempfile::tempdir().unwrap();
        std::fs::write(logs.path().join(FILE_NAME), "x".repeat(60)).unwrap();
        std::fs::write(
            logs.path().join("theodore-20261002-000000000.jsonl"),
            "y".repeat(30),
        )
        .unwrap();
        std::fs::write(
            logs.path().join("theodore-20261001-000000000.jsonl"),
            "z".repeat(30),
        )
        .unwrap();
        let picked: Vec<String> = pick_logs(logs.path(), 100)
            .into_iter()
            .map(|(p, _)| p.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        assert_eq!(
            picked,
            ["theodore.jsonl", "theodore-20261002-000000000.jsonl"]
        );
    }

    #[test]
    fn only_report_paths_can_be_revealed() {
        std::fs::create_dir_all(reports_dir()).unwrap();
        let inside = reports_dir().join("probe-reveal.txt");
        std::fs::write(&inside, "").unwrap();
        assert!(is_report_path(&inside));
        assert!(!is_report_path(Path::new("/etc/hosts")));
        assert!(!is_report_path(&reports_dir().join("../../etc")));
        let _ = std::fs::remove_file(inside);
    }
}
