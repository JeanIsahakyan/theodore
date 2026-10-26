//! Chat attachments: files sent with a space's message or an AI panel
//! question (images, PDFs, anything). Each is saved once, under
//! `<data dir>/attachments/<id>/<name>`, and referenced by id afterwards:
//!
//! ```text
//! save_attachment(name, mime, base64) ──▶ <data>/attachments/<uuid>/<name>
//!                                          └── .attachment.json {name, mime}
//! space_send / ask { attachments: [id] } ──▶ resolve ──▶ stored on your message
//!                                                    └─▶ prompt block + AgentRequest
//! ```

use std::path::{Path, PathBuf};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde::{Deserialize, Serialize};
use theodore_contract::{Attachment, SaveAttachmentRequest};
use theodore_ports::AgentAttachment;

use crate::core::Core;
use crate::error::{AppError, AppResult};

/// Largest file `save_attachment` takes, decoded.
pub const MAX_ATTACHMENT_BYTES: usize = 25 * 1024 * 1024;
/// Under the attachments dir.
const DIR: &str = "attachments";
/// Next to the file, in its id's directory. Starts with a dot, which a
/// sanitized name never does, so it can't collide with the file.
const META: &str = ".attachment.json";

#[derive(Serialize, Deserialize)]
struct Meta {
    name: String,
    mime: String,
}

impl Core {
    fn attachments_dir(&self) -> PathBuf {
        self.0.deps.data_dir.join(DIR)
    }

    /// Saves one file and returns it with its id and absolute path.
    pub async fn save_attachment(&self, req: SaveAttachmentRequest) -> AppResult<Attachment> {
        // Refuse a payload that can't fit before decoding it at all.
        if req.data.len() / 4 * 3 > MAX_ATTACHMENT_BYTES + 3 {
            return Err(too_big(&req.name));
        }
        let bytes = STANDARD
            .decode(req.data.trim())
            .map_err(|e| AppError::Invalid(format!("attachment {} isn't base64: {e}", req.name)))?;
        if bytes.len() > MAX_ATTACHMENT_BYTES {
            return Err(too_big(&req.name));
        }
        let name = sanitize_name(&req.name);
        // The given type, unless it's missing or not a `type/subtype`.
        let mime = match req.mime.trim() {
            m if is_mime(m) => m.to_ascii_lowercase(),
            _ => guess_mime(&name).to_string(),
        };
        let id = uuid::Uuid::new_v4().to_string();
        let dir = self.attachments_dir().join(&id);
        let meta = serde_json::to_vec(&Meta {
            name: name.clone(),
            mime: mime.clone(),
        })
        .map_err(|e| AppError::Invalid(e.to_string()))?;
        let path = dir.join(&name);
        let size = bytes.len() as u64;
        let write_path = path.clone();
        tokio::task::spawn_blocking(move || -> std::io::Result<()> {
            std::fs::create_dir_all(&dir)?;
            std::fs::write(&write_path, &bytes)?;
            std::fs::write(dir.join(META), meta)
        })
        .await
        .map_err(AppError::join)?
        .map_err(|e| AppError::Invalid(format!("couldn't save attachment {name}: {e}")))?;
        Ok(Attachment {
            id,
            name,
            mime,
            size,
            path: path.display().to_string(),
        })
    }

    /// A saved attachment as a `data:<mime>;base64,…` URL (an image `src`).
    pub async fn attachment_data(&self, id: String) -> AppResult<String> {
        let att = self
            .load_attachment(&id)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("attachment {id}")))?;
        let path = PathBuf::from(&att.path);
        let bytes = tokio::task::spawn_blocking(move || std::fs::read(path))
            .await
            .map_err(AppError::join)?
            .map_err(|_| AppError::NotFound(format!("attachment {id}")))?;
        Ok(format!(
            "data:{};base64,{}",
            att.mime,
            STANDARD.encode(bytes)
        ))
    }

    /// The attachments a message names, in order, duplicates dropped. An
    /// id that isn't a saved attachment fails the whole message.
    pub(crate) async fn resolve_attachments(
        &self,
        ids: Option<&[String]>,
    ) -> AppResult<Vec<Attachment>> {
        let mut out: Vec<Attachment> = Vec::new();
        for id in ids.unwrap_or_default() {
            if out.iter().any(|a| &a.id == id) {
                continue;
            }
            match self.load_attachment(id).await? {
                Some(att) => out.push(att),
                None => return Err(AppError::Invalid(format!("unknown attachment {id}"))),
            }
        }
        Ok(out)
    }

    /// `None` for an id that isn't saved; `Invalid` for one that isn't an
    /// id at all (no path ever leaves the attachments dir).
    async fn load_attachment(&self, id: &str) -> AppResult<Option<Attachment>> {
        if !is_attachment_id(id) {
            return Err(AppError::Invalid(format!("not an attachment id: {id:?}")));
        }
        let dir = self.attachments_dir().join(id);
        let id = id.to_string();
        tokio::task::spawn_blocking(move || read_attachment(&dir, id))
            .await
            .map_err(AppError::join)
    }
}

fn read_attachment(dir: &Path, id: String) -> Option<Attachment> {
    let meta: Meta = serde_json::from_slice(&std::fs::read(dir.join(META)).ok()?).ok()?;
    // The stored name went through `sanitize_name`; checked again so an
    // edited meta file can't point outside the directory.
    if sanitize_name(&meta.name) != meta.name {
        return None;
    }
    let path = dir.join(&meta.name);
    let size = std::fs::metadata(&path).ok().filter(|m| m.is_file())?.len();
    Some(Attachment {
        id,
        name: meta.name,
        mime: meta.mime,
        size,
        path: path.display().to_string(),
    })
}

fn too_big(name: &str) -> AppError {
    AppError::Invalid(format!(
        "{name} is over the {} MB attachment limit",
        MAX_ATTACHMENT_BYTES / (1024 * 1024)
    ))
}

/// A file name safe to put in the attachment's directory: the last path
/// component only, no separators or control characters, no leading dots;
/// `file` if nothing is left.
pub fn sanitize_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or_default();
    let clean: String = base
        .chars()
        .filter(|c| !c.is_control() && *c != ':')
        .collect();
    let clean = clean.trim().trim_start_matches('.').trim();
    if clean.is_empty() {
        return "file".to_string();
    }
    // Most file systems cap a name at 255 bytes.
    let mut out = String::new();
    for c in clean.chars() {
        if out.len() + c.len_utf8() > 200 {
            break;
        }
        out.push(c);
    }
    out
}

/// What `save_attachment` hands out: a UUID. Letters, digits and `-` only,
/// so it can't name anything outside the attachments dir.
pub fn is_attachment_id(id: &str) -> bool {
    (1..=64).contains(&id.len()) && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// `type/subtype` (parameters allowed), nothing that could break a
/// `data:` URL or the prompt line it's listed on.
fn is_mime(m: &str) -> bool {
    m.len() <= 127
        && m.split_once('/')
            .is_some_and(|(t, s)| !t.is_empty() && !s.is_empty())
        && m.chars().all(|c| {
            c.is_ascii_alphanumeric() || matches!(c, '/' | '.' | '+' | '-' | '_' | '=' | ';')
        })
}

/// A mime type from a file name's extension, for a file sent without one.
pub fn guess_mime(name: &str) -> &'static str {
    let ext = Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "heic" => "image/heic",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "pdf" => "application/pdf",
        "json" => "application/json",
        "zip" => "application/zip",
        "csv" => "text/csv",
        "html" | "htm" => "text/html",
        "md" => "text/markdown",
        "txt" | "log" => "text/plain",
        "xml" => "application/xml",
        "yaml" | "yml" => "application/yaml",
        _ => "application/octet-stream",
    }
}

/// `prompt` with the files it was sent with listed after it, so the agent
/// knows to open them. Unchanged without attachments.
pub fn with_attachments(prompt: String, attachments: &[Attachment]) -> String {
    if attachments.is_empty() {
        return prompt;
    }
    let mut out = prompt;
    if !out.is_empty() {
        out.push_str("\n\n");
    }
    out.push_str("Attached files (read them; images and PDFs too):");
    for a in attachments {
        out.push_str(&format!("\n- {} ({}, {})", a.path, a.mime, a.name));
    }
    out
}

/// What the runner needs to let the agent open them.
pub fn agent_attachments(attachments: &[Attachment]) -> Vec<AgentAttachment> {
    attachments
        .iter()
        .map(|a| AgentAttachment {
            path: PathBuf::from(&a.path),
            mime: a.mime.clone(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_keep_only_a_safe_basename() {
        assert_eq!(sanitize_name("shot.png"), "shot.png");
        assert_eq!(sanitize_name("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_name("C:\\Users\\me\\report.pdf"), "report.pdf");
        assert_eq!(sanitize_name(".env"), "env");
        assert_eq!(sanitize_name("...hidden"), "hidden");
        assert_eq!(sanitize_name("a\nb\u{0}.txt"), "ab.txt");
        assert_eq!(sanitize_name("Screen Shot 1.png"), "Screen Shot 1.png");
        assert_eq!(sanitize_name("скрин.png"), "скрин.png");
        for empty in ["", "/", "..", "dir/", "  ", "."] {
            assert_eq!(sanitize_name(empty), "file", "{empty:?}");
        }
        assert!(sanitize_name(&"x".repeat(1000)).len() <= 200);
    }

    #[test]
    fn ids_are_plain_tokens() {
        assert!(is_attachment_id("0b6e8a52-3c1f-4d7e-9a1b-2f3c4d5e6f70"));
        for bad in [
            "",
            "..",
            "../x",
            "a/b",
            "a\\b",
            "a.b",
            " a",
            &"a".repeat(65),
        ] {
            assert!(!is_attachment_id(bad), "{bad:?}");
        }
    }

    #[test]
    fn mime_is_guessed_from_the_extension() {
        assert_eq!(guess_mime("a.PNG"), "image/png");
        assert_eq!(guess_mime("spec.pdf"), "application/pdf");
        assert_eq!(guess_mime("file"), "application/octet-stream");
        assert!(is_mime("image/png"));
        assert!(is_mime(
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        ));
        for bad in [
            "",
            "png",
            "image/",
            "/png",
            "image/png\n- /etc/passwd",
            "a/b,c",
        ] {
            assert!(!is_mime(bad), "{bad:?}");
        }
    }

    fn att(name: &str, mime: &str) -> Attachment {
        Attachment {
            id: "1".into(),
            name: name.into(),
            mime: mime.into(),
            size: 3,
            path: format!("/data/attachments/1/{name}"),
        }
    }

    #[test]
    fn the_prompt_lists_the_files_after_the_text() {
        assert_eq!(with_attachments("Fix it".into(), &[]), "Fix it");
        assert_eq!(
            with_attachments(String::new(), &[att("a.txt", "text/plain")]),
            "Attached files (read them; images and PDFs too):\n\
             - /data/attachments/1/a.txt (text/plain, a.txt)"
        );
        assert_eq!(
            with_attachments(
                "Fix it".into(),
                &[
                    att("shot.png", "image/png"),
                    att("spec.pdf", "application/pdf")
                ]
            ),
            "Fix it\n\nAttached files (read them; images and PDFs too):\n\
             - /data/attachments/1/shot.png (image/png, shot.png)\n\
             - /data/attachments/1/spec.pdf (application/pdf, spec.pdf)"
        );
    }
}
