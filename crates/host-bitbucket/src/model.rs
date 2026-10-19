//! REST API 2.0 wire shapes. Only the fields the adapter reads; Bitbucket's
//! responses carry far more (`type` discriminators, extra `links`, …),
//! `serde` ignores the rest.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Deserialize)]
pub(crate) struct BbLink {
    pub href: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub(crate) struct BbLinks {
    #[serde(default)]
    pub avatar: Option<BbLink>,
}

/// Bitbucket deprecated `username` account-wide (privacy); `nickname` is the
/// closest surviving human-readable handle, `uuid` the one guaranteed to
/// exist.
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct BbUser {
    pub uuid: String,
    #[serde(default)]
    pub nickname: Option<String>,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub account_id: Option<String>,
    #[serde(default)]
    pub links: BbLinks,
}

impl BbUser {
    pub(crate) fn handle(&self) -> &str {
        self.nickname
            .as_deref()
            .or(self.account_id.as_deref())
            .unwrap_or(&self.uuid)
    }
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct BbCommitRef {
    pub hash: String,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct BbBranch {
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct BbRepoRef {
    pub full_name: String,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct BbEndpoint {
    pub branch: BbBranch,
    pub commit: Option<BbCommitRef>,
    #[serde(default)]
    pub repository: Option<BbRepoRef>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct BbParticipant {
    pub user: BbUser,
    /// `"REVIEWER"` or `"PARTICIPANT"`.
    pub role: String,
    #[serde(default)]
    pub approved: bool,
    /// `"approved"` / `"changes_requested"` / absent.
    #[serde(default)]
    pub state: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct BbPrLinks {
    pub html: BbLink,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct BbPullRequest {
    pub id: u64,
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    /// `OPEN` / `MERGED` / `DECLINED` / `SUPERSEDED`.
    pub state: String,
    #[serde(default)]
    pub draft: bool,
    pub author: BbUser,
    pub source: BbEndpoint,
    pub destination: BbEndpoint,
    #[serde(default)]
    pub reviewers: Vec<BbUser>,
    #[serde(default)]
    pub participants: Vec<BbParticipant>,
    pub updated_on: String,
    pub links: BbPrLinks,
    #[serde(default)]
    pub merge_commit: Option<BbCommitRef>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct BbDiffStatEntry {
    #[serde(default)]
    pub lines_added: u32,
    #[serde(default)]
    pub lines_removed: u32,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct BbCommitAuthor {
    pub raw: String,
    #[serde(default)]
    pub user: Option<BbUser>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct BbCommit {
    pub hash: String,
    pub message: String,
    pub author: BbCommitAuthor,
    pub date: String,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct BbStatus {
    pub key: String,
    #[serde(default)]
    pub name: Option<String>,
    /// `SUCCESSFUL` / `FAILED` / `INPROGRESS` / `STOPPED`.
    pub state: String,
    #[serde(default)]
    pub url: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub(crate) struct BbContent {
    pub raw: String,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct BbParentRef {
    pub id: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub(crate) struct BbInline {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct BbComment {
    pub id: u64,
    pub content: BbContent,
    pub user: BbUser,
    pub created_on: String,
    #[serde(default)]
    pub updated_on: Option<String>,
    #[serde(default)]
    pub deleted: bool,
    #[serde(default)]
    pub parent: Option<BbParentRef>,
    #[serde(default)]
    pub inline: Option<BbInline>,
    /// Present (any shape) once the thread this comment roots is resolved.
    #[serde(default)]
    pub resolution: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct BbRepository {
    pub full_name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub is_private: bool,
    #[serde(default)]
    pub updated_on: Option<String>,
}

// ── request bodies ──────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub(crate) struct CreateCommentBody<'a> {
    pub content: BbContent,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inline: Option<&'a BbInline>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent: Option<ParentIdBody>,
}

#[derive(Debug, Serialize)]
pub(crate) struct ParentIdBody {
    pub id: u64,
}

#[derive(Debug, Serialize, Default)]
pub(crate) struct MergeBody<'a> {
    pub merge_strategy: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<&'a str>,
    pub close_source_branch: bool,
}
