//! The local log: JSON lines in `<data dir>/logs/theodore.jsonl`, always
//! on. Written from a background thread through a bounded queue (a full
//! queue drops lines rather than stall the caller), rotated daily and by
//! size, with the total kept under a cap.
//!
//! ```text
//! theodore.jsonl ──(new UTC day, or > max_file_bytes)──▶ theodore-<stamp>.jsonl
//!                                                        oldest deleted while
//!                                                        count > max_files or
//!                                                        total > max_total_bytes
//! ```

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, TrySendError, sync_channel};
use std::time::Duration;

use chrono::{NaiveDate, Utc};

use crate::record::Record;
use crate::sink::Sink;

pub const FILE_NAME: &str = "theodore.jsonl";
const PREFIX: &str = "theodore-";
const SUFFIX: &str = ".jsonl";

#[derive(Debug, Clone)]
pub struct Rotation {
    pub max_file_bytes: u64,
    pub max_total_bytes: u64,
    /// Rotated files kept, besides the current one.
    pub max_files: usize,
}

impl Default for Rotation {
    fn default() -> Self {
        Self {
            max_file_bytes: 10 * 1024 * 1024,
            max_total_bytes: 50 * 1024 * 1024,
            max_files: 9,
        }
    }
}

/// The current file plus its rotated predecessors. Synchronous; the sink
/// below drives it from its own thread.
pub struct RotatingFile {
    dir: PathBuf,
    rotation: Rotation,
    file: Option<File>,
    size: u64,
    day: NaiveDate,
    today: Box<dyn Fn() -> NaiveDate + Send>,
}

impl RotatingFile {
    pub fn open(dir: impl Into<PathBuf>, rotation: Rotation) -> std::io::Result<Self> {
        Self::with_clock(dir, rotation, Box::new(|| Utc::now().date_naive()))
    }

    /// `today` decides daily rotation (tests pass a fake clock).
    pub fn with_clock(
        dir: impl Into<PathBuf>,
        rotation: Rotation,
        today: Box<dyn Fn() -> NaiveDate + Send>,
    ) -> std::io::Result<Self> {
        let dir = dir.into();
        std::fs::create_dir_all(&dir)?;
        let current = dir.join(FILE_NAME);
        let now = today();
        // A file left by an earlier day starts that day's archive.
        let day = std::fs::metadata(&current)
            .and_then(|m| m.modified())
            .ok()
            .map(|t| chrono::DateTime::<Utc>::from(t).date_naive())
            .unwrap_or(now);
        let mut f = Self {
            dir,
            rotation,
            file: None,
            size: 0,
            day,
            today,
        };
        if day != now {
            f.rotate()?;
        }
        f.reopen()?;
        Ok(f)
    }

    fn reopen(&mut self) -> std::io::Result<()> {
        let path = self.dir.join(FILE_NAME);
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        self.size = file.metadata().map(|m| m.len()).unwrap_or(0);
        self.file = Some(file);
        Ok(())
    }

    pub fn write_line(&mut self, line: &str) -> std::io::Result<()> {
        let now = (self.today)();
        let len = line.len() as u64 + 1;
        if now != self.day || (self.size > 0 && self.size + len > self.rotation.max_file_bytes) {
            self.rotate()?;
            self.day = now;
            self.reopen()?;
        }
        let file = match self.file.as_mut() {
            Some(f) => f,
            None => {
                self.reopen()?;
                self.file.as_mut().expect("just opened")
            }
        };
        file.write_all(line.as_bytes())?;
        file.write_all(b"\n")?;
        self.size += len;
        Ok(())
    }

    pub fn flush(&mut self) -> std::io::Result<()> {
        match self.file.as_mut() {
            Some(f) => f.flush(),
            None => Ok(()),
        }
    }

    /// Moves the current file aside and prunes old ones.
    fn rotate(&mut self) -> std::io::Result<()> {
        self.file = None;
        let current = self.dir.join(FILE_NAME);
        if std::fs::metadata(&current).map(|m| m.len()).unwrap_or(0) > 0 {
            let stamp = format!(
                "{}{}",
                self.day.format("%Y%m%d"),
                Utc::now().format("-%H%M%S%3f")
            );
            let mut target = self.dir.join(format!("{PREFIX}{stamp}{SUFFIX}"));
            let mut n = 1;
            while target.exists() {
                target = self.dir.join(format!("{PREFIX}{stamp}-{n}{SUFFIX}"));
                n += 1;
            }
            std::fs::rename(&current, &target)?;
        }
        prune(&self.dir, &self.rotation);
        Ok(())
    }
}

/// Rotated files, oldest first (their names sort by time).
pub fn rotated_files(dir: &Path) -> Vec<(PathBuf, u64)> {
    let mut files: Vec<(PathBuf, u64)> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            (name.starts_with(PREFIX) && name.ends_with(SUFFIX))
                .then(|| (e.path(), e.metadata().map(|m| m.len()).unwrap_or(0)))
        })
        .collect();
    files.sort();
    files
}

fn prune(dir: &Path, rotation: &Rotation) {
    let mut files = rotated_files(dir);
    let current = std::fs::metadata(dir.join(FILE_NAME))
        .map(|m| m.len())
        .unwrap_or(0);
    let mut total: u64 = current + files.iter().map(|(_, n)| n).sum::<u64>();
    while !files.is_empty()
        && (files.len() > rotation.max_files || total > rotation.max_total_bytes)
    {
        let (path, n) = files.remove(0);
        if std::fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(n);
        }
    }
}

enum Msg {
    Line(String),
    Flush(SyncSender<()>),
}

/// The file sink: a bounded queue in front of a `RotatingFile` on its own
/// thread.
pub struct FileSink {
    tx: Mutex<Option<SyncSender<Msg>>>,
    dropped: AtomicU64,
    thread: Mutex<Option<std::thread::JoinHandle<()>>>,
}

const QUEUE: usize = 8192;

impl FileSink {
    pub fn start(file: RotatingFile) -> Self {
        let (tx, rx) = sync_channel(QUEUE);
        let thread = std::thread::Builder::new()
            .name("theodore-log".into())
            .spawn(move || run(file, rx))
            .ok();
        Self {
            tx: Mutex::new(Some(tx)),
            dropped: AtomicU64::new(0),
            thread: Mutex::new(thread),
        }
    }

    pub fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }

    /// Flushes and stops the writer thread.
    pub fn close(&self) {
        let tx = self.tx.lock().unwrap_or_else(|p| p.into_inner()).take();
        drop(tx);
        if let Some(t) = self.thread.lock().unwrap_or_else(|p| p.into_inner()).take() {
            let _ = t.join();
        }
    }
}

fn run(mut file: RotatingFile, rx: Receiver<Msg>) {
    while let Ok(msg) = rx.recv() {
        match msg {
            Msg::Line(l) => {
                let _ = file.write_line(&l);
            }
            Msg::Flush(ack) => {
                let _ = file.flush();
                let _ = ack.send(());
            }
        }
    }
    let _ = file.flush();
}

impl Sink for FileSink {
    fn write(&self, record: &Record) {
        let guard = self.tx.lock().unwrap_or_else(|p| p.into_inner());
        let Some(tx) = guard.as_ref() else { return };
        let mut line = record.to_line();
        let dropped = self.dropped.swap(0, Ordering::Relaxed);
        if dropped > 0 {
            // Say so in the log itself, once the queue has room again.
            line = format!(
                "{}\n{line}",
                Record::new(
                    tracing::Level::WARN,
                    "theodore_telemetry",
                    "log lines dropped"
                )
                .with_field("dropped", dropped)
                .to_line()
            );
        }
        match tx.try_send(Msg::Line(line)) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) => {
                self.dropped.fetch_add(dropped + 1, Ordering::Relaxed);
            }
            Err(TrySendError::Disconnected(_)) => {}
        }
    }

    fn flush(&self, timeout: Duration) {
        let (ack_tx, ack_rx) = sync_channel(1);
        let sent = {
            let guard = self.tx.lock().unwrap_or_else(|p| p.into_inner());
            guard
                .as_ref()
                .is_some_and(|tx| tx.send(Msg::Flush(ack_tx)).is_ok())
        };
        if sent {
            let _ = ack_rx.recv_timeout(timeout);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::AtomicI64;

    use super::*;

    fn names(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        v.sort();
        v
    }

    fn day(n: i64) -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 10, 1).unwrap() + chrono::Days::new(n as u64)
    }

    #[test]
    fn rotates_by_size_and_keeps_the_newest_files() {
        let dir = tempfile::tempdir().unwrap();
        let rotation = Rotation {
            max_file_bytes: 100,
            max_total_bytes: 10_000,
            max_files: 2,
        };
        let mut f = RotatingFile::with_clock(dir.path(), rotation, Box::new(|| day(0))).unwrap();
        for i in 0..20 {
            f.write_line(&format!("{i:02}{}", "x".repeat(38))).unwrap();
        }
        f.flush().unwrap();
        let files = names(dir.path());
        // The current file plus two rotated ones.
        assert_eq!(files.len(), 3, "{files:?}");
        assert!(files.contains(&FILE_NAME.to_string()));
        let current = std::fs::read_to_string(dir.path().join(FILE_NAME)).unwrap();
        assert!(current.ends_with(&format!("19{}\n", "x".repeat(38))));
        assert!(current.len() <= 100);
        // The oldest lines are gone.
        let all: String = files
            .iter()
            .map(|n| std::fs::read_to_string(dir.path().join(n)).unwrap())
            .collect();
        assert!(!all.contains("00xxx"));
    }

    #[test]
    fn rotation_caps_the_total_size() {
        let dir = tempfile::tempdir().unwrap();
        let rotation = Rotation {
            max_file_bytes: 50,
            max_total_bytes: 160,
            max_files: 100,
        };
        let mut f = RotatingFile::with_clock(dir.path(), rotation, Box::new(|| day(0))).unwrap();
        for _ in 0..40 {
            f.write_line(&"y".repeat(40)).unwrap();
        }
        let total: u64 = std::fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .map(|e| e.metadata().unwrap().len())
            .sum();
        // Pruned at each rotation, so at most one file over the cap.
        assert!(total <= 160 + 50, "{total}");
        assert!(rotated_files(dir.path()).len() <= 3);
    }

    #[test]
    fn rotates_when_the_day_changes() {
        let dir = tempfile::tempdir().unwrap();
        let now = Arc::new(AtomicI64::new(0));
        let clock = now.clone();
        let mut f = RotatingFile::with_clock(
            dir.path(),
            Rotation::default(),
            Box::new(move || day(clock.load(Ordering::SeqCst))),
        )
        .unwrap();
        f.write_line("monday").unwrap();
        now.store(1, Ordering::SeqCst);
        f.write_line("tuesday").unwrap();
        f.flush().unwrap();
        let rotated = rotated_files(dir.path());
        assert_eq!(rotated.len(), 1);
        let name = rotated[0]
            .0
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_string();
        assert!(name.starts_with("theodore-20261001-"), "{name}");
        assert_eq!(std::fs::read_to_string(&rotated[0].0).unwrap(), "monday\n");
        assert_eq!(
            std::fs::read_to_string(dir.path().join(FILE_NAME)).unwrap(),
            "tuesday\n"
        );
    }

    #[test]
    fn the_sink_writes_json_lines_and_flushes() {
        let dir = tempfile::tempdir().unwrap();
        let sink = FileSink::start(RotatingFile::open(dir.path(), Rotation::default()).unwrap());
        sink.write(&Record::new(tracing::Level::INFO, "theodore_app", "hello").with_field("n", 1));
        sink.flush(Duration::from_secs(5));
        let text = std::fs::read_to_string(dir.path().join(FILE_NAME)).unwrap();
        let v: serde_json::Value = serde_json::from_str(text.trim()).unwrap();
        assert_eq!(v["msg"], "hello");
        assert_eq!(v["n"], 1);
        sink.close();
    }
}
