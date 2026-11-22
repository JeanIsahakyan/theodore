//! Files between devices, this device as the host (docs/fleet.md "Files
//! (blobs)"): what another device attached to a start or send lands in the
//! space's `.context/`, and `read_file` hands a file of a space's worktree
//! back, sealed for the origin.
//!
//! ```text
//! request{attachments} ─▶ the gate (validate_blobs: ≤ 10, ≤ 20 MiB each) ─▶ claim
//!   ─▶ GET ×chunks ─▶ open_blob(own seed) ─▶ bytes in memory, every file
//!   ─▶ <worktree>/.context/<safe name> (" (2)" on a clash) + "/.context/" in info/exclude
//!   ─▶ DELETE ×blobs ─▶ the message's attachments ─▶ the turn (prompt line, images)
//!   any failure ─▶ fleet.attachment_failed / fleet.too_large, partial files removed, no turn
//!
//! read_file{space, path, max_bytes} ─▶ Ask, the space here with a worktree
//!   ─▶ path inside it (no `..`, no absolute, no symlink out, never .git)
//!   ─▶ size ≤ min(max_bytes, 50 MiB) else fleet.too_large
//!   ─▶ seal_blob(origin's pin) ─▶ PUT ×chunks ─▶ ok {blob}
//! ```
//!
//! Logs: direction, bytes, chunks, ms and the outcome of every transfer;
//! never a file name or path (docs/telemetry.md).

use std::path::{Component, Path, PathBuf};
use std::time::Instant;

use theodore_contract::{Attachment, Space};
use theodore_fleet_protocol::blob::{MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, MAX_READ_FILE_BYTES};
use theodore_fleet_protocol::{BlobError, BlobRef, ReadFileResult, codes, open_blob, seal_blob};
use theodore_ports::{BlobAccess, BlobStoreError};

use crate::core::Core;
use crate::error::{AppError, AppResult};
use crate::usecases::attachments::guess_mime;
use crate::usecases::fleet_host::Refusal;

/// Where files from other devices land, under the space's worktree.
pub const CONTEXT_DIR: &str = ".context";
/// The exclude line that keeps it out of git's own view of the worktree
/// (Theodore's checkpoints leave it out regardless: `crates/git`).
pub const CONTEXT_EXCLUDE: &str = "/.context/";

fn refuse(code: &'static str, message: impl Into<String>) -> Refusal {
    (code, message.into())
}

/// A file another device sent: fetched, opened and checked, not written yet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ReceivedFile {
    pub blob_id: String,
    pub name: String,
    pub mime: String,
    pub bytes: Vec<u8>,
}

/// A failed attachment as the origin hears of it: too many or too large
/// are `fleet.too_large`, anything else `fleet.attachment_failed`.
pub(crate) fn blob_refusal(e: &BlobError) -> Refusal {
    match e {
        BlobError::TooLarge => refuse(
            codes::TOO_LARGE,
            format!(
                "an attachment is over {} MiB",
                MAX_ATTACHMENT_BYTES / (1024 * 1024)
            ),
        ),
        BlobError::TooManyAttachments => refuse(
            codes::TOO_LARGE,
            format!("at most {MAX_ATTACHMENTS} attachments per message"),
        ),
        other => refuse(
            codes::ATTACHMENT_FAILED,
            format!("an attachment couldn't be taken: {other}"),
        ),
    }
}

/// A blob store failure on the way in (an attachment): the file didn't
/// arrive, whatever the cloud said.
fn fetch_refusal(e: &BlobStoreError) -> Refusal {
    match e {
        BlobStoreError::TooLarge => refuse(codes::TOO_LARGE, "an attachment is too large"),
        _ => refuse(
            codes::ATTACHMENT_FAILED,
            format!("an attachment couldn't be fetched: {e}"),
        ),
    }
}

/// A blob store failure on the way out (`read_file`).
fn upload_refusal(e: &BlobStoreError) -> Refusal {
    match e {
        BlobStoreError::TooLarge => refuse(codes::TOO_LARGE, "the file is too large to send"),
        BlobStoreError::Quota => refuse(codes::QUOTA, "this account's file storage is full"),
        BlobStoreError::Unauthorized => refuse(
            codes::UNAUTHORIZED,
            "the cloud refused this device's token for the file",
        ),
        other => refuse(
            codes::INTERNAL,
            format!("the file couldn't be uploaded: {other}"),
        ),
    }
}

impl Core {
    /// The blob routes: the link's cloud and a current access token.
    async fn fleet_blob_access(&self) -> Result<BlobAccess, Refusal> {
        let cloud_url = self
            .fleet()
            .link
            .as_ref()
            .map(|l| l.cloud_url.clone())
            .ok_or_else(|| refuse(codes::INTERNAL, "this device isn't connected to the cloud"))?;
        let access_token = self
            .account_access_token()
            .await
            .ok()
            .flatten()
            .ok_or_else(|| refuse(codes::INTERNAL, "this device isn't signed in"))?;
        Ok(BlobAccess {
            cloud_url,
            access_token,
        })
    }

    /// Downloads and opens every attachment of a request: the bytes stay in
    /// memory until the space they are for has a worktree. Nothing is
    /// deleted from the cloud yet. Any failure refuses the whole request.
    pub(crate) async fn fleet_fetch_attachments(
        &self,
        refs: &[BlobRef],
    ) -> Result<Vec<ReceivedFile>, Refusal> {
        if refs.is_empty() {
            return Ok(Vec::new());
        }
        if refs.len() > MAX_ATTACHMENTS {
            return Err(blob_refusal(&BlobError::TooManyAttachments));
        }
        let access = self.fleet_blob_access().await?;
        let key = self
            .fleet_key()
            .await
            .map_err(|e| refuse(codes::INTERNAL, e.to_string()))?;
        let mut out = Vec::with_capacity(refs.len());
        for r in refs {
            let started = Instant::now();
            let got = self.fleet_fetch_one(&access, key.seed(), r).await;
            let ms = started.elapsed().as_millis() as u64;
            match got {
                Ok(bytes) => {
                    tracing::info!(
                        direction = "in",
                        bytes = r.size,
                        chunks = r.chunks,
                        ms,
                        outcome = "ok",
                        "fleet file transfer"
                    );
                    out.push(ReceivedFile {
                        blob_id: r.blob_id.clone(),
                        name: r.name.clone(),
                        mime: if r.mime.trim().is_empty() {
                            guess_mime(&r.name).to_string()
                        } else {
                            r.mime.clone()
                        },
                        bytes,
                    });
                }
                Err((code, why)) => {
                    tracing::warn!(
                        error.code = code,
                        direction = "in",
                        bytes = r.size,
                        chunks = r.chunks,
                        ms,
                        outcome = "failed",
                        "fleet file transfer failed"
                    );
                    return Err((code, why));
                }
            }
        }
        Ok(out)
    }

    async fn fleet_fetch_one(
        &self,
        access: &BlobAccess,
        seed: &[u8; 32],
        r: &BlobRef,
    ) -> Result<Vec<u8>, Refusal> {
        r.validate().map_err(|e| blob_refusal(&e))?;
        if r.size > MAX_ATTACHMENT_BYTES {
            return Err(blob_refusal(&BlobError::TooLarge));
        }
        let mut chunks = Vec::with_capacity(r.chunks as usize);
        for i in 0..r.chunks {
            let chunk = self
                .0
                .deps
                .fleet
                .get_chunk(access, &r.blob_id, i)
                .await
                .map_err(|e| fetch_refusal(&e))?;
            chunks.push(chunk);
        }
        open_blob(seed, r, &chunks).map_err(|e| blob_refusal(&e))
    }

    /// Writes `files` into `worktree`'s `.context/` (made if needed, kept
    /// out of git), each under its safe name (` (2)`, ` (3)` on a clash),
    /// and deletes their blobs from the cloud. A failed write removes what
    /// was written and refuses. The message's attachments, in order.
    pub(crate) async fn fleet_write_context(
        &self,
        worktree: &Path,
        files: Vec<ReceivedFile>,
    ) -> Result<Vec<Attachment>, Refusal> {
        if files.is_empty() {
            return Ok(Vec::new());
        }
        let ids: Vec<String> = files.iter().map(|f| f.blob_id.clone()).collect();
        let dir = worktree.join(CONTEXT_DIR);
        let written = tokio::task::spawn_blocking(move || write_context_files(&dir, files))
            .await
            .map_err(|e| refuse(codes::INTERNAL, e.to_string()))?
            .map_err(|e| {
                tracing::warn!(error.code = codes::ATTACHMENT_FAILED, error = %e, "couldn't write a space's .context files");
                refuse(
                    codes::ATTACHMENT_FAILED,
                    format!("the files couldn't be written: {e}"),
                )
            })?;
        // Git itself leaves the folder alone from here on; Theodore's own
        // checkpoints never took it (crates/git).
        if let Err(e) = self
            .0
            .deps
            .git
            .space_exclude_pattern(worktree, CONTEXT_EXCLUDE)
            .await
        {
            tracing::warn!(error.code = e.code(), error = %e, "couldn't exclude .context in the worktree");
        }
        // Fetched and kept: the cloud's copy has no reader left.
        if let Ok(access) = self.fleet_blob_access().await {
            for id in &ids {
                if let Err(e) = self.0.deps.fleet.delete_blob(&access, id).await {
                    tracing::debug!(error.code = e.code(), "a fetched blob wasn't deleted");
                }
            }
        }
        Ok(written)
    }

    /// Fetches and writes the attachments of a request for `worktree`:
    /// [`fleet_fetch_attachments`](Self::fleet_fetch_attachments) then
    /// [`fleet_write_context`](Self::fleet_write_context).
    pub(crate) async fn fleet_receive_attachments(
        &self,
        worktree: &Path,
        refs: &[BlobRef],
    ) -> Result<Vec<Attachment>, Refusal> {
        let files = self.fleet_fetch_attachments(refs).await?;
        self.fleet_write_context(worktree, files).await
    }

    /// Files another device sent for a space being made (`start_space`),
    /// by local space id: written once the worktree exists
    /// (`fleet_write_pending_context`).
    pub(crate) fn fleet_stash_context(&self, space: &str, files: Vec<ReceivedFile>) {
        if files.is_empty() {
            return;
        }
        self.0
            .fleet
            .pending_context
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(space.to_string(), files);
    }

    pub(crate) fn fleet_take_context(&self, space: &str) -> Vec<ReceivedFile> {
        self.0
            .fleet
            .pending_context
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(space)
            .unwrap_or_default()
    }

    /// Right after a space's worktree exists: its stashed files, if any,
    /// into `.context/`, then waiting for its first send
    /// (`fleet_take_attachments`). An error names the attachments, so the
    /// fleet start refuses with its own code.
    pub(crate) async fn fleet_write_pending_context(
        &self,
        space: &str,
        worktree: &Path,
    ) -> AppResult<()> {
        let files = self.fleet_take_context(space);
        if files.is_empty() {
            return Ok(());
        }
        let written = self
            .fleet_write_context(worktree, files)
            .await
            .map_err(|(code, why)| AppError::Invalid(format!("{ATTACHMENTS_ERR}{code}: {why}")))?;
        self.fleet_stash_attachments(space, written);
        Ok(())
    }

    /// Attachments written for `space`, to go with its next message
    /// (a fleet send, or a start's goal).
    pub(crate) fn fleet_stash_attachments(&self, space: &str, files: Vec<Attachment>) {
        if files.is_empty() {
            return;
        }
        self.0
            .fleet
            .pending_attachments
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .entry(space.to_string())
            .or_default()
            .extend(files);
    }

    /// The attachments waiting for `space`'s next message, taken.
    pub(crate) fn fleet_take_attachments(&self, space: &str) -> Vec<Attachment> {
        self.0
            .fleet
            .pending_attachments
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(space)
            .unwrap_or_default()
    }

    /// Deletes the `.context/` files a message brought (a queued message
    /// dropped or cancelled): only those under the space's own `.context/`.
    pub(crate) async fn fleet_remove_context_files(&self, space: &Space, files: &[Attachment]) {
        let paths: Vec<PathBuf> = context_paths(Path::new(&space.worktree), files);
        if paths.is_empty() {
            return;
        }
        let _ = tokio::task::spawn_blocking(move || {
            for p in paths {
                let _ = std::fs::remove_file(p);
            }
        })
        .await;
    }

    /// `read_file`: `path` of `space`'s worktree, sealed for the origin
    /// whose pinned key is `origin_key`, uploaded; the reply's value.
    pub(crate) async fn fleet_read_file(
        &self,
        space: &Space,
        origin_key: &str,
        path: &str,
        max_bytes: u64,
    ) -> Result<serde_json::Value, Refusal> {
        if space.worktree.is_empty() {
            return Err(refuse(
                codes::INVALID,
                "this space has no worktree on this device",
            ));
        }
        let worktree = PathBuf::from(&space.worktree);
        let limit = max_bytes.min(MAX_READ_FILE_BYTES);
        let rel = path.to_string();
        let read = tokio::task::spawn_blocking(move || -> Result<(String, Vec<u8>), Refusal> {
            let full = resolve_in_worktree(&worktree, &rel)?;
            let meta = std::fs::metadata(&full)
                .map_err(|_| refuse(codes::INVALID, "no such file in this space"))?;
            if !meta.is_file() {
                return Err(refuse(codes::INVALID, "that path isn't a file"));
            }
            if meta.len() > limit {
                return Err(refuse(
                    codes::TOO_LARGE,
                    format!("the file is {} bytes, over the {limit} allowed", meta.len()),
                ));
            }
            let bytes = std::fs::read(&full)
                .map_err(|e| refuse(codes::INTERNAL, format!("couldn't read the file: {e}")))?;
            if bytes.len() as u64 > limit {
                return Err(refuse(codes::TOO_LARGE, "the file grew past the limit"));
            }
            let name = full
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("file")
                .to_string();
            Ok((name, bytes))
        })
        .await
        .map_err(|e| refuse(codes::INTERNAL, e.to_string()))??;
        let (name, bytes) = read;
        let started = Instant::now();
        let sent = self.fleet_upload(origin_key, &name, bytes).await;
        let ms = started.elapsed().as_millis() as u64;
        match &sent {
            Ok(r) => tracing::info!(
                direction = "out",
                bytes = r.size,
                chunks = r.chunks,
                ms,
                outcome = "ok",
                "fleet file transfer"
            ),
            Err((code, _)) => tracing::warn!(
                error.code = code,
                direction = "out",
                ms,
                outcome = "failed",
                "fleet file transfer failed"
            ),
        }
        let blob = sent?;
        serde_json::to_value(ReadFileResult { blob })
            .map_err(|e| refuse(codes::INTERNAL, e.to_string()))
    }

    /// Seals `bytes` for `recipient_key` and uploads every chunk; a failed
    /// chunk takes the whole blob down.
    async fn fleet_upload(
        &self,
        recipient_key: &str,
        name: &str,
        bytes: Vec<u8>,
    ) -> Result<BlobRef, Refusal> {
        let access = self.fleet_blob_access().await?;
        let mime = guess_mime(name);
        let (r, chunks) = seal_blob(recipient_key, &bytes, name, mime).map_err(|e| match e {
            BlobError::TooLarge => refuse(codes::TOO_LARGE, "the file is too large to send"),
            BlobError::BadRecipientKey => refuse(
                codes::INVALID,
                "the requesting device's key can't take files",
            ),
            other => refuse(codes::INTERNAL, other.to_string()),
        })?;
        drop(bytes);
        let total = chunks.len() as u32;
        for (i, chunk) in (0u32..).zip(chunks) {
            if let Err(e) = self
                .0
                .deps
                .fleet
                .put_chunk(&access, &r.blob_id, i, total, chunk)
                .await
            {
                let _ = self.0.deps.fleet.delete_blob(&access, &r.blob_id).await;
                return Err(upload_refusal(&e));
            }
        }
        Ok(r)
    }
}

/// The prefix of an `AppError` made by a failed `.context` write during a
/// space's creation (`fleet_host_start` reads the code after it).
pub(crate) const ATTACHMENTS_ERR: &str = "attachments: ";

/// Writes every file under `dir`, a free name each; on any failure removes
/// what this call wrote.
fn write_context_files(dir: &Path, files: Vec<ReceivedFile>) -> std::io::Result<Vec<Attachment>> {
    std::fs::create_dir_all(dir)?;
    let mut written: Vec<PathBuf> = Vec::new();
    let mut out = Vec::with_capacity(files.len());
    for f in files {
        let name = theodore_fleet_protocol::safe_attachment_name(&f.name);
        let path = free_name(dir, &name, &written);
        if let Err(e) = std::fs::write(&path, &f.bytes) {
            for p in &written {
                let _ = std::fs::remove_file(p);
            }
            let _ = std::fs::remove_file(&path);
            return Err(e);
        }
        written.push(path.clone());
        out.push(Attachment {
            id: uuid::Uuid::new_v4().to_string(),
            name: path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(&name)
                .to_string(),
            mime: f.mime,
            size: f.bytes.len() as u64,
            path: path.display().to_string(),
        });
    }
    Ok(out)
}

/// `dir/name`, or `dir/stem (n).ext` when `taken` or the disk has it.
fn free_name(dir: &Path, name: &str, taken: &[PathBuf]) -> PathBuf {
    let p = Path::new(name);
    let (stem, ext) = match (p.file_stem().and_then(|s| s.to_str()), p.extension()) {
        (Some(stem), Some(ext)) if !stem.is_empty() => {
            (stem.to_string(), ext.to_str().map(str::to_string))
        }
        _ => (name.to_string(), None),
    };
    (1u32..)
        .map(|n| match (n, &ext) {
            (1, _) => dir.join(name),
            (n, Some(e)) => dir.join(format!("{stem} ({n}).{e}")),
            (n, None) => dir.join(format!("{stem} ({n})")),
        })
        .find(|c| !taken.contains(c) && std::fs::symlink_metadata(c).is_err())
        .expect("some name is free")
}

/// Of `files`, the paths directly under `worktree/.context/` (nothing else
/// is ever removed by Theodore).
pub(crate) fn context_paths(worktree: &Path, files: &[Attachment]) -> Vec<PathBuf> {
    if worktree.as_os_str().is_empty() {
        return Vec::new();
    }
    let dir = worktree.join(CONTEXT_DIR);
    files
        .iter()
        .map(|a| PathBuf::from(&a.path))
        .filter(|p| p.parent() == Some(dir.as_path()))
        .collect()
}

/// `files` that are the space's own `.context/` files, and the rest.
pub(crate) fn split_context(
    worktree: &Path,
    files: &[Attachment],
) -> (Vec<Attachment>, Vec<Attachment>) {
    let ctx = context_paths(worktree, files);
    files
        .iter()
        .cloned()
        .partition(|a| ctx.iter().any(|p| p.as_os_str() == a.path.as_str()))
}

/// `prompt` with the `.context/` files another device sent listed after
/// it: "Attached files (in .context/): shot.png (image/png, 340 KB), …".
pub(crate) fn with_context_files(prompt: String, files: &[Attachment]) -> String {
    if files.is_empty() {
        return prompt;
    }
    let list: Vec<String> = files
        .iter()
        .map(|a| format!("{} ({}, {})", a.name, a.mime, human_size(a.size)))
        .collect();
    let mut out = prompt;
    if !out.is_empty() {
        out.push_str("\n\n");
    }
    out.push_str(&format!(
        "Attached files (in {CONTEXT_DIR}/): {}",
        list.join(", ")
    ));
    out
}

/// `true` for an attachment the agent should see as an image.
pub(crate) fn is_image(a: &Attachment) -> bool {
    a.mime.starts_with("image/")
}

fn human_size(bytes: u64) -> String {
    const KB: u64 = 1024;
    const MB: u64 = 1024 * 1024;
    if bytes >= MB {
        format!("{:.1} MB", bytes as f64 / MB as f64)
    } else if bytes >= KB {
        format!("{} KB", bytes.div_ceil(KB))
    } else {
        format!("{bytes} B")
    }
}

/// `rel` inside `worktree`: relative, plain components only (no `..`), no
/// `.git` component, and what it resolves to (symlinks followed) still
/// under the worktree. Fails closed.
pub(crate) fn resolve_in_worktree(worktree: &Path, rel: &str) -> Result<PathBuf, Refusal> {
    let denied = || refuse(codes::INVALID, "the path must be a file inside the space");
    let rel = rel.trim();
    if rel.is_empty() || rel.contains('\0') {
        return Err(denied());
    }
    let p = Path::new(rel);
    if p.is_absolute() || rel.starts_with(['/', '\\']) {
        return Err(denied());
    }
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::Normal(n) => {
                if n.to_str().is_none_or(|s| s.eq_ignore_ascii_case(".git")) {
                    return Err(denied());
                }
            }
            _ => return Err(denied()),
        }
    }
    let root = std::fs::canonicalize(worktree).map_err(|_| denied())?;
    let real = std::fs::canonicalize(worktree.join(p)).map_err(|_| denied())?;
    if !real.starts_with(&root) {
        return Err(denied());
    }
    if real.strip_prefix(&root).ok().is_some_and(|r| {
        r.components()
            .any(|c| c.as_os_str().eq_ignore_ascii_case(".git"))
    }) {
        return Err(denied());
    }
    if !std::fs::metadata(&real).is_ok_and(|m| m.is_file()) {
        return Err(denied());
    }
    Ok(real)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn att(name: &str, mime: &str, size: u64, path: &str) -> Attachment {
        Attachment {
            id: "a".into(),
            name: name.into(),
            mime: mime.into(),
            size,
            path: path.into(),
        }
    }

    #[test]
    fn the_prompt_lists_context_files_with_type_and_size() {
        let files = [
            att("shot.png", "image/png", 348_160, "/w/.context/shot.png"),
            att("log.txt", "text/plain", 12, "/w/.context/log.txt"),
            att(
                "big.zip",
                "application/zip",
                3 * 1024 * 1024 + 512 * 1024,
                "/w/.context/big.zip",
            ),
        ];
        assert_eq!(
            with_context_files("Fix it".into(), &files),
            "Fix it\n\nAttached files (in .context/): shot.png (image/png, 340 KB), \
             log.txt (text/plain, 12 B), big.zip (application/zip, 3.5 MB)"
        );
        assert_eq!(with_context_files("Fix it".into(), &[]), "Fix it");
        assert!(with_context_files(String::new(), &files[..1]).starts_with("Attached files"));
    }

    #[test]
    fn only_files_right_under_the_context_dir_count_as_context() {
        let wt = Path::new("/w");
        let files = [
            att("a.png", "image/png", 1, "/w/.context/a.png"),
            att("b.txt", "text/plain", 1, "/data/attachments/x/b.txt"),
            att("c.txt", "text/plain", 1, "/w/.context/deeper/c.txt"),
            att("d.txt", "text/plain", 1, "/w/src/.context/d.txt"),
        ];
        let (ctx, rest) = split_context(wt, &files);
        assert_eq!(ctx.len(), 1);
        assert_eq!(ctx[0].name, "a.png");
        assert_eq!(rest.len(), 3);
        assert!(context_paths(Path::new(""), &files).is_empty());
    }

    #[test]
    fn clashing_names_get_a_counter_before_the_extension() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join(".context");
        let file = |name: &str| ReceivedFile {
            blob_id: "b".into(),
            name: name.into(),
            mime: "text/plain".into(),
            bytes: b"x".to_vec(),
        };
        let first = write_context_files(&dir, vec![file("log.txt"), file("log.txt")]).unwrap();
        assert_eq!(first[0].name, "log.txt");
        assert_eq!(first[1].name, "log (2).txt");
        let again = write_context_files(&dir, vec![file("log.txt"), file("Makefile")]).unwrap();
        assert_eq!(again[0].name, "log (3).txt");
        assert_eq!(again[1].name, "Makefile");
        let again =
            write_context_files(&dir, vec![file("Makefile"), file("../../etc/passwd")]).unwrap();
        assert_eq!(again[0].name, "Makefile (2)");
        assert_eq!(again[1].name, "passwd");
        assert!(dir.join("passwd").is_file());
        assert!(!tmp.path().join("etc").exists());
    }

    #[test]
    fn a_failed_write_removes_what_was_written() {
        let tmp = tempfile::tempdir().unwrap();
        // A directory so deep that a short name still fits under the OS's
        // path limit (1024 on macOS, 4096 elsewhere) and a 200-character
        // one doesn't: the second write fails after the first succeeded.
        let limit = if cfg!(target_os = "macos") {
            1024
        } else {
            4096
        };
        let mut dir = tmp.path().to_path_buf();
        while dir.as_os_str().len() < limit - 120 {
            dir.push("d".repeat(100));
        }
        let dir = dir.join(".context");
        let file = |name: &str| ReceivedFile {
            blob_id: "b".into(),
            name: name.into(),
            mime: "text/plain".into(),
            bytes: b"x".to_vec(),
        };
        let long = format!("{}.txt", "x".repeat(196));
        let r = write_context_files(&dir, vec![file("ok.txt"), file(&long)]);
        assert!(r.is_err(), "{r:?}");
        assert!(!dir.join("ok.txt").exists());
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn paths_resolve_inside_the_worktree_only() {
        let tmp = tempfile::tempdir().unwrap();
        let wt = tmp.path().join("wt");
        let out = tmp.path().join("out");
        std::fs::create_dir_all(wt.join("src")).unwrap();
        std::fs::create_dir_all(wt.join(".git")).unwrap();
        std::fs::create_dir_all(&out).unwrap();
        std::fs::write(wt.join("src/a.rs"), "a").unwrap();
        std::fs::write(wt.join(".git/config"), "c").unwrap();
        std::fs::write(out.join("secret"), "s").unwrap();
        std::os::unix::fs::symlink(out.join("secret"), wt.join("link")).unwrap();
        std::os::unix::fs::symlink(&out, wt.join("dir")).unwrap();
        std::os::unix::fs::symlink(wt.join(".git"), wt.join("gitlink")).unwrap();
        std::os::unix::fs::symlink("src/a.rs", wt.join("inside")).unwrap();

        let ok = resolve_in_worktree(&wt, "src/a.rs").unwrap();
        assert_eq!(ok, std::fs::canonicalize(wt.join("src/a.rs")).unwrap());
        assert!(resolve_in_worktree(&wt, "./src/a.rs").is_ok());
        assert!(
            resolve_in_worktree(&wt, "inside").is_ok(),
            "a link inside stays inside"
        );
        for bad in [
            "",
            "../wt/src/a.rs",
            "src/../../out/secret",
            "/etc/passwd",
            "\\etc",
            ".git/config",
            "src/../.git/config",
            ".GIT/config",
            "link",
            "dir/secret",
            "gitlink/config",
            "src",
            "missing.txt",
            "src/a.rs\0",
        ] {
            let r = resolve_in_worktree(&wt, bad);
            assert!(r.is_err(), "{bad:?} resolved to {r:?}");
        }
        let abs = wt.join("src/a.rs").display().to_string();
        assert!(
            resolve_in_worktree(&wt, &abs).is_err(),
            "absolute, even inside"
        );
    }

    #[test]
    fn sizes_read_like_a_file_dialog() {
        assert_eq!(human_size(0), "0 B");
        assert_eq!(human_size(1023), "1023 B");
        assert_eq!(human_size(1024), "1 KB");
        assert_eq!(human_size(1500), "2 KB");
        assert_eq!(human_size(20 * 1024 * 1024), "20.0 MB");
    }
}
