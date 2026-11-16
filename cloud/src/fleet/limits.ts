/**
 * Fleet numbers and codes. The first block mirrors
 * `crates/fleet-protocol/src/lib.rs` (the source of truth; the TS export
 * carries types only); the rest are the cloud's own (docs/cloud.md "Fleet").
 */

export const PROTOCOL_VERSION = 4;
/**
 * The oldest protocol still accepted. Protocol-3 connections never see
 * `mobile` / `web` devices (their `DeviceKind` can't read them) nor
 * `delegations`.
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

/** A request to an offline target waits this long for it to come back. */
export const GRACE_MS = 10_000;
/** A pending request (or a reply held for an offline origin) lives this long. */
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
/** Open sockets per user, said hello or not. */
export const MAX_CONNS_PER_USER = 10;
/** A space whose host has been offline this long is forgotten. */
export const HOST_OFFLINE_PRUNE_MS = 30 * 24 * 3_600_000;
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

/** `mirror` models the cloud keeps, the latest per `(model, id)`. */
export const MIRROR_KEPT = ['space', 'chat_message'] as const;
/** `mirror` models relayed live, never stored. */
export const MIRROR_RELAYED = ['turn_step'] as const;
/** A `mirror` event's `id`. */
export const MAX_MIRROR_ID_CHARS = 256;

export const codes = {
  BAD_SIGNATURE: 'fleet.bad_signature',
  UNKNOWN_SPACE: 'fleet.unknown_space',
  DEPTH: 'fleet.depth',
  OFFLINE: 'fleet.offline',
  BUSY: 'fleet.busy',
  INTERNAL: 'fleet.internal',
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
   * web app's, which a protocol-3 computer can't see, so can't trust). */
  UPGRADE_REQUIRED: 'fleet.upgrade_required',
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
