/**
 * Fleet numbers and codes. The first block mirrors
 * `crates/fleet-protocol/src/lib.rs` (the source of truth; the TS export
 * carries types only); the rest are the cloud's own (docs/cloud.md "Fleet").
 */

export const PROTOCOL_VERSION = 9;
/**
 * The oldest protocol still accepted. Protocol-3 connections never see
 * `mobile` / `web` devices (their `DeviceKind` can't read them) nor
 * `delegations`; protocol 3 and 4 never see the cloud's own `mcp` device;
 * below 6, no `confirm` / `confirm_dismissed` frames nor the `confirm` /
 * `set_mcp_auto` ops; below 7, none of the ops on any space of a computer
 * (`list_spaces` … `merge_child`); below 9, no `archive_space` /
 * `unarchive_space` (8 added the blob transfer: attachments, `read_file`).
 */
export const MIN_PROTOCOL_VERSION = 3;
/** A signed request or delegation older or newer than this is stale. */
export const REQUEST_WINDOW_MS = 5 * 60_000;
/** The challenge nonce; a hello signs exactly this many bytes. */
export const NONCE_BYTES = 32;
export const MAX_DEPTH = 2;
export const MAX_CHILDREN = 5;
export const CLOUD_RING = 500;
export const MAX_FRAME_BYTES = 256 * 1024;
/** `DeviceInfo.agents` (`fit_agents` keeps a device's within these). */
export const MAX_AGENTS = 4;
export const MAX_AGENT_MODELS = 12;
export const MAX_MODEL_EFFORTS = 8;
export const MAX_AGENT_ID_CHARS = 32;
export const MAX_MODEL_ID_CHARS = 64;
export const MAX_AGENT_LABEL_CHARS = 64;
export const MAX_EFFORT_CHARS = 16;
/** `DeviceInfo.mcp_auto`: one per `mcp` device a host pins. */
export const MAX_MCP_AUTO = 8;
/** Characters of a `RemoteConfirm`'s text (`CONFIRM_TEXT_MAX`). */
export const CONFIRM_TEXT_MAX = 500;

/** A request to an offline target waits this long for it to come back. */
export const GRACE_MS = 10_000;
/**
 * A pending request (or a reply held for an offline origin) lives this long;
 * one from the MCP device, REQUEST_WINDOW_MS (the host may ask a person).
 */
export const PENDING_TTL_MS = 2 * 60_000;
/** An unanswered question goes to every device after this. */
export const ESCALATE_MS = 20_000;
/** A focused, unlocked device with input this recent is where you are. */
export const ACTIVE_IDLE_MS = 60_000;
/** A connection whose access token expired this long ago is closed. */
export const REAUTH_LEEWAY_MS = 60_000;
/** A connection that hasn't said hello by then is closed. */
export const HELLO_TIMEOUT_MS = 10_000;
export const MAX_DEVICES_PER_USER = 20;
export const MAX_PENDING_PER_USER = 100;
/** Spaces the cloud keeps per user; over it the oldest finished one goes. */
export const MAX_SPACES_PER_USER = 200;
export const MAX_ASKS_PER_SPACE = 20;
export const MAX_ASKS_PER_USER = 100;
/** Open confirms (a host's `RemoteConfirm`s) per user. */
export const MAX_CONFIRMS_PER_USER = 20;
/** Open sockets per user, said hello or not. */
export const MAX_CONNS_PER_USER = 10;
/** A space whose host has been offline this long is forgotten. */
export const HOST_OFFLINE_PRUNE_MS = 30 * 24 * 3_600_000;
/**
 * A deleted account is refused this long (`gone_users`): longer than any
 * access token it signed in with lives, so none of them brings rows back.
 */
export const GONE_USER_MS = 24 * 3_600_000;
/**
 * Token bucket per connection. The burst is above the spec's example (200)
 * so a device replaying its journal after a reconnect isn't cut off.
 */
export const RATE_PER_SECOND = 50;
export const RATE_BURST = 500;
/** 20 devices × this stays under one frame for the `devices` list. */
export const MAX_INFO_BYTES = 8 * 1024;
/** One stored space event (reply texts are ≤ 8000 chars). */
export const MAX_EVENT_BYTES = 64 * 1024;

/** Pushes one device may be sent per minute; over it they're dropped. */
export const PUSH_PER_MINUTE = 30;
/** A push token as Expo issues it. */
export const MAX_PUSH_TOKEN_CHARS = 200;
/** A question's text in a push body. */
export const PUSH_BODY_CHARS = 180;
/** Option labels a push carries as notification actions. */
export const PUSH_ACTIONS = 4;
/**
 * Stored event bytes (body length; a `started` body counts twice: its ring
 * copy and the one kept apart). Per space, ring and mirrors together: the
 * ring's oldest go (a long chat's mirrored rows must fit, ≤ 48 KiB each);
 * mirrors alone over it are refused (`fleet.busy`). Per user: the oldest of
 * finished spaces go, events then mirrors, then new events are refused.
 */
export const MAX_SPACE_EVENT_BYTES = 16 * 1024 * 1024;
export const MAX_USER_EVENT_BYTES = 128 * 1024 * 1024;

/**
 * The `mirror` model of a sub-space of a hosted space (protocol 7,
 * `SUB_SPACE_MODEL`): `id` the child's local id on the host, `data` a
 * `MirroredSubSpace` (null: gone).
 */
export const SUB_SPACE_MODEL = 'sub_space';
/** `mirror` models the cloud keeps, the latest per `(model, id)`. */
export const MIRROR_KEPT = ['space', 'chat_message', SUB_SPACE_MODEL] as const;
/** `mirror` models relayed live, never stored. */
export const MIRROR_RELAYED = ['turn_step'] as const;
/** A `mirror` event's `id`. */
export const MAX_MIRROR_ID_CHARS = 256;

/**
 * The ops on any space of a computer (protocol 7), bounded only: the
 * target checks them. A space id there is the target's own (or an `rs_`
 * one); a question or message as long as an MCP goal.
 */
export const MAX_ANY_SPACE_ID_CHARS = 64;
export const MAX_ANY_SPACE_TEXT_CHARS = 20_000;
/** `read_space.messages` (the target's default: 10). */
export const MAX_READ_MESSAGES = 50;

/**
 * Blobs (`src/fleet/blobs.ts`): an end-to-end encrypted file goes through
 * R2 in chunks of ≤ 4 MiB plaintext, each AEAD-sealed (+ 16 bytes tag); the
 * cap leaves room for that and a little framing.
 */
export const BLOB_CHUNK_BYTES = 4 * 1024 * 1024 + 64;
/** Chunks per blob (`x-theodore-chunks`), so a blob is ≤ 256 MiB. */
export const BLOB_MAX_CHUNKS = 64;
/** A blob id: 32 lowercase hex characters, drawn at random by the sender. */
export const BLOB_ID = /^[0-9a-f]{32}$/;
/** Per user per UTC day (one counter per org hub): uploaded bytes, chunks. */
export const BLOB_DAY_BYTES = 1024 * 1024 * 1024;
export const BLOB_DAY_CHUNKS = 2000;
/** The R2 lifecycle rule drops an object this old (docs/cloud.md "Blobs"). */
export const BLOB_TTL_HOURS = 24;

export const codes = {
  BAD_SIGNATURE: 'fleet.bad_signature',
  UNKNOWN_SPACE: 'fleet.unknown_space',
  DEPTH: 'fleet.depth',
  OFFLINE: 'fleet.offline',
  BUSY: 'fleet.busy',
  INTERNAL: 'fleet.internal',
  /** An mcp device's edit or run the person on the host denied (or let lapse). */
  DENIED: 'fleet.denied',
  /** A slow op (`ask_space`'s answer) didn't finish on the target in time. */
  TIMEOUT: 'fleet.timeout',
  UNAUTHORIZED: 'fleet.unauthorized',
  NO_ORG: 'fleet.no_org',
  VERSION: 'fleet.version',
  KEY_MISMATCH: 'fleet.key_mismatch',
  TOO_LARGE: 'fleet.too_large',
  RATE_LIMITED: 'fleet.rate_limited',
  NOT_YOURS: 'fleet.not_yours',
  INVALID: 'fleet.invalid',
  STALE_REQUEST: 'fleet.stale_request',
  // the cloud's own, not in the Rust list
  BAD_MESSAGE: 'fleet.bad_message',
  TOO_MANY_DEVICES: 'fleet.too_many_devices',
  TOO_MANY_SPACES: 'fleet.too_many_spaces',
  TOO_MANY_CONNECTIONS: 'fleet.too_many_connections',
  /** The cloud couldn't check a token (signing keys unreachable): redial. */
  UNAVAILABLE: 'fleet.unavailable',
  /** The target runs a Theodore too old for this request (a phone's or the
   * web app's, which a protocol-3 computer can't see, so can't trust; an op
   * its protocol doesn't have). */
  UPGRADE_REQUIRED: 'fleet.upgrade_required',
  /** No such blob chunk for this org (`GET /v1/fleet/blobs/…`). */
  BLOB_NOT_FOUND: 'fleet.blob_not_found',
  /** The user's blob upload quota for today is spent. */
  QUOTA: 'fleet.quota',
} as const;

/**
 * WebSocket close codes the hub uses; the reason is the `fleet.*` code. The
 * device adapter treats 4001 and 4003 as fatal (no redial), anything else
 * as "redial with backoff".
 */
export const close = {
  POLICY: 1008,
  TOO_BIG: 1009,
  /** A newer connection of the same device took over. */
  REPLACED: 4000,
  /** Auth: unauthorized, no_org, expired token. */
  AUTH: 4001,
  /** Forbidden: key_mismatch, version, too_many_devices. */
  FORBIDDEN: 4003,
  /** The cloud couldn't check the token (JWKS down): not fatal, redial. */
  UNAVAILABLE: 1011,
} as const;

/** The close code a refusal ends the connection with. */
export function closeCodeFor(code: string): number {
  switch (code) {
    case codes.UNAUTHORIZED:
    case codes.NO_ORG:
      return close.AUTH;
    case codes.KEY_MISMATCH:
    case codes.VERSION:
    // Redialing can't help until a device is removed.
    case codes.TOO_MANY_DEVICES:
      return close.FORBIDDEN;
    case codes.TOO_LARGE:
      return close.TOO_BIG;
    case codes.UNAVAILABLE:
      return close.UNAVAILABLE;
    default:
      return close.POLICY;
  }
}
