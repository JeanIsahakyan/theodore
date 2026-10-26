//! Files attached to a chat message (a space's chat, the AI panel's
//! questions): images, PDFs, anything. Saved once with `save_attachment`,
//! then referenced by id from `SpaceSendRequest` / `AskRequest`.

use serde::{Deserialize, Serialize};
use specta::Type;

/// A saved file. `path` is absolute: the agent reads it from there.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct Attachment {
    pub id: String,
    pub name: String,
    pub mime: String,
    /// Bytes on disk.
    pub size: u64,
    pub path: String,
}

/// `save_attachment`: one file's bytes. Over 25 MB decoded is refused.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct SaveAttachmentRequest {
    /// The file's name; only its last component is kept.
    pub name: String,
    /// Empty = guessed from the name's extension.
    pub mime: String,
    /// The file's bytes, base64 (standard alphabet).
    pub data: String,
}
