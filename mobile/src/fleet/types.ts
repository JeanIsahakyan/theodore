/**
 * The fleet as this app sees it (docs/fleet.md, docs/mobile.md). Wire types
 * come from `src/gen/fleet.ts` (generated from Rust; never edited).
 * `FleetClient` is implemented in `src/fleet/client.ts`; screens read the
 * zustand store in `src/state/fleet.ts` and call the client's methods.
 */
import type { BlobRef, ConfirmAction, FleetMode, McpAuto } from '../gen/fleet';
import type { SpaceMirror } from './mirror';

export type { BlobRef } from '../gen/fleet';

/** A file to send: its bytes, name and mime type (docs/mobile.md "Files"). */
export interface FileToSend {
  bytes: Uint8Array;
  name: string;
  mime: string;
}

export type ConnectionState = 'off' | 'connecting' | 'connected' | 'error';

/** A model a host lists for an agent (`FleetModelInfo`, shape-checked). */
export interface FleetModelView {
  id: string;
  label: string;
  /** Levels `effort` may name with this model; empty: none. */
  efforts: string[];
  defaultEffort: string | null;
}

/**
 * An agent a host runs for remote spaces (`FleetAgentInfo`, docs/fleet.md
 * "Agent, model and effort"): what a start or send may pick there.
 */
export interface FleetAgentView {
  id: string;
  label: string;
  /** What runs when a request names no model; `null`: the CLI's own. */
  defaultModel: string | null;
  /** What runs when a request names no effort. */
  defaultEffort: string | null;
  models: FleetModelView[];
}

/**
 * An agent, model or effort picked for a start or a send, from what the
 * host lists. `null` / absent: not picked (a start: the host's default; a
 * send: the space's own).
 */
export interface AgentPicks {
  agent?: string | null;
  model?: string | null;
  effort?: string | null;
}

/**
 * A computer's auto mode for one Claude via the cloud (`mcp`) device it
 * pins (`DeviceInfo.mcp_auto`, docs/fleet.md "Auto mode"), shape-checked.
 */
export interface McpAutoView {
  /** The `mcp` device. */
  deviceId: string;
  /** Its listed name, else "Claude via cloud". */
  name: string;
  /** `off` once `untilMs` has passed. */
  auto: McpAuto;
  /** Unix ms it ends; `null`: until turned off. */
  untilMs: number | null;
}

export interface FleetDeviceView {
  deviceId: string;
  name: string;
  /** desktop | daemon | mobile | web | mcp */
  kind: string;
  os: string;
  online: boolean;
  acceptsRemote: boolean;
  maxMode: FleetMode;
  projects: { id: string; name: string }[];
  /** Agents a start or send may pick, its default first; empty from a host
   *  older than the field (then none is offered or sent). */
  agents: FleetAgentView[];
  publicKey: string;
  /** 8 groups of 4 hex, as the desktop shows it. */
  fingerprint: string;
  /** Pinned on this device. */
  trusted: boolean;
  thisDevice: boolean;
  /** A computer's auto mode per `mcp` device it pins; empty elsewhere. */
  mcpAuto: McpAutoView[];
}

/**
 * A request from Claude via the cloud waiting on a pinned computer for a
 * person's Allow / Deny (`RemoteConfirm`, verified with the host's pin).
 */
export interface ConfirmView {
  confirmId: string;
  hostDevice: string;
  /** The host's pinned name. */
  hostName: string;
  mcpDevice: string;
  action: ConfirmAction;
  mode: FleetMode;
  /** `start`: the project, as the host names it; else "". */
  projectName: string;
  /** `send` / `approve_plan`: the space, as the host names it; else "". */
  spaceName: string;
  /** The goal or the message. */
  text: string;
  /** Unix ms: refused on the host unless answered before. */
  expiresAtMs: number;
}

export type SpaceStatus =
  'starting' | 'running' | 'idle' | 'waiting' | 'stopped' | 'failed';

export interface QuestionView {
  askId: string;
  space: string;
  /** "<pinned host name> · <space name>" */
  from: string;
  questions: { question: string; options: string[]; multi: boolean }[];
}

export interface SpaceView {
  space: string;
  hostDevice: string;
  hostName: string;
  originDevice: string;
  projectName: string;
  name: string;
  branch: string;
  status: SpaceStatus;
  mode: FleetMode;
  lastReply: string | null;
  question: QuestionView | null;
  /** Started from this device (vs followed through a delegation). */
  startedHere: boolean;
  error: string | null;
  /**
   * Archived on the host (its row says so, or `archiveSpace` succeeded):
   * still tracked, so Undo (`unarchiveSpace`) is instant, but left out of
   * the published list. Never `true` on a listed space.
   */
  archived?: boolean;
  /**
   * Unix ms of its last activity, for the drawer's "Today / Yesterday"
   * groups: the host's mirrored row's `updated_at`, else when something of
   * it last arrived here. Set when published, never saved.
   */
  activeAt?: number;
}

export type LineKind =
  | 'started'
  | 'status'
  | 'turn'
  | 'tool'
  | 'reply'
  | 'ended'
  | 'question'
  | 'gap';

/** What the host did with a message: ran it, or queued it behind the
 *  running turn (`position` 1 runs next). */
export interface SendResult {
  /** The chat row's id on the host (its mirrored `chat_message`); `null`
   *  from a host that doesn't say. */
  message: string | null;
  queued: boolean;
  position: number | null;
}

export interface SpaceLine {
  seq: number;
  kind: LineKind;
  text: string;
}

/** One of a sub-space's last messages (`read_space`), shape-checked. */
export interface SubSpaceMessage {
  /** `user`, `space:<id>` (another space's agent), or the agent's name. */
  from: string;
  at: number;
  text: string;
  truncated: boolean;
}

/**
 * A space on a host read by its local id (`read_space`, docs/fleet.md "Any
 * space on a computer"): what the sub-space screen shows. Every field is
 * shape-checked (`src/fleet/rules.ts` `spaceReadOf`): it is the host's
 * signed word, but still another device's text.
 */
export interface SubSpaceRead {
  /** Its local id on the host. */
  space: string;
  title: string;
  /** `setting_up`, `running`, `question`, `waiting`, `idle`, `failed`, `archived`. */
  status: string;
  mode: FleetMode | null;
  agent: string | null;
  turns: number;
  done: boolean;
  goal: string;
  branch: string;
  progress: { label: string; state: 'pending' | 'active' | 'done' }[];
  progressNote: string | null;
  /** The newest, oldest first. */
  messages: SubSpaceMessage[];
  /** The running turn's text so far. */
  live: string | null;
  question: {
    ask: string;
    questions: { question: string; options: string[]; multi: boolean }[];
  } | null;
  error: string | null;
}

export interface FleetSnapshot {
  connection: ConnectionState;
  error: string | null;
  /**
   * This run's first `devices` list (sent right after the welcome) arrived:
   * what is listed is the fleet's word, not "nothing yet" (`src/ui/load.ts`).
   * Reset by sign-out and an org switch.
   */
  welcomed: boolean;
  deviceId: string | null;
  fingerprint: string;
  devices: FleetDeviceView[];
  spaces: SpaceView[];
  lines: Record<string, SpaceLine[]>;
  /** The host's own rows of a space, when it mirrors them (`src/fleet/mirror.ts`). */
  mirrors: Record<string, SpaceMirror>;
  /** Questions routed to this device that aren't answered yet. */
  questions: QuestionView[];
  /** Claude via cloud's requests waiting on a computer for Allow / Deny. */
  confirms: ConfirmView[];
}

/**
 * Who a one-shot request is signed in as when it isn't the active account
 * (a notification for another signed-in account): that account's token in
 * the org the space lives in; this device's id in that org is read here.
 */
export interface PushIdentity {
  accessToken: string;
  organizationId: string;
}

export interface FleetClient {
  /** Connects (or reconnects) with the current session; idempotent. */
  start(): Promise<void>;
  stop(): void;
  /**
   * Tells the cloud to forget this device's push token in the connected
   * organization (the active account signs out of this device); the token
   * itself is kept for the next account's link.
   */
  dropPushHere(): Promise<void>;
  /** Removes the saved sets of these `<user>.<org>` scopes (an account left). */
  forgetSaved(scopes: readonly string[]): Promise<void>;
  /** `agent` / `model` / `effort`: only what was picked; the host's
   *  defaults run for the rest. `attachments`: blobs uploaded for that
   *  computer (`uploadAttachment`), for the space's `.context/`. */
  startSpace(
    req: {
      deviceId: string;
      projectId: string;
      goal: string;
      mode: FleetMode;
      attachments?: BlobRef[];
    } & AgentPicks,
  ): Promise<SpaceView>;
  /** `mode`: the turn's, when it isn't the space's own; `picks`: an agent,
   *  model or effort from this turn on (none: the space's own). While the
   *  space runs the host queues it (docs/fleet.md "Sends queue").
   *  `attachments`: blobs uploaded for the space's host. */
  send(
    space: string,
    text: string,
    mode?: FleetMode | null,
    picks?: AgentPicks,
    attachments?: BlobRef[],
  ): Promise<SendResult>;
  stopSpace(space: string): Promise<void>;
  /**
   * Archives a space followed here, as the host's own Archive does
   * (`archive_space`: edits checkpointed, worktree removed, branch and PR
   * kept). Refused `fleet.busy` while its turn runs. Once the host says ok
   * the space leaves the list; `unarchiveSpace` brings it back.
   */
  archiveSpace(space: string): Promise<void>;
  /** Undo of `archiveSpace` (`unarchive_space`: the worktree recreated). */
  unarchiveSpace(space: string): Promise<void>;
  /** One entry per question: chosen options, or one free text. */
  answer(space: string, askId: string, answers: string[][]): Promise<void>;
  /** Pins exactly `publicKey` (refused if the cloud now lists another). */
  trust(deviceId: string, publicKey: string): Promise<void>;
  untrust(deviceId: string): Promise<void>;
  lines(space: string): Promise<SpaceLine[]>;
  registerPush(token: string | null): Promise<void>;
  /** Signs and sends a request without the socket (notification action);
   *  `as`: for another signed-in account's space. */
  answerOverHttp(
    space: string,
    askId: string,
    answers: string[][],
    hostDevice: string,
    as?: PushIdentity | null,
  ): Promise<void>;
  /**
   * Allow or Deny a confirm waiting on `hostDevice`. The card goes once
   * sent, whatever the host says; a late answer (`fleet.invalid`: answered
   * elsewhere, or expired) resolves quietly, other refusals throw.
   */
  confirm(hostDevice: string, confirmId: string, allow: boolean): Promise<void>;
  /** `confirm` without the socket (notification action). */
  confirmOverHttp(
    hostDevice: string,
    confirmId: string,
    allow: boolean,
    as?: PushIdentity | null,
  ): Promise<void>;
  /**
   * Sets a pinned computer's auto mode for an `mcp` device it pins; the new
   * state comes back in the next devices list.
   */
  setMcpAuto(
    hostDevice: string,
    mcpDevice: string,
    auto: McpAuto,
    untilMs: number | null,
  ): Promise<void>;
  /**
   * Reads a space on `hostDevice` by its local id (a sub-space of a space
   * followed here): its last `messages` (at most 50), running text,
   * question (`read_space`). The host's verified answer, shape-checked.
   */
  readSpace(
    hostDevice: string,
    space: string,
    messages?: number,
  ): Promise<SubSpaceRead>;
  /** A message as that space's next turn, in its own mode (`send_to`);
   *  queued while it runs. */
  sendTo(
    hostDevice: string,
    space: string,
    text: string,
    attachments?: BlobRef[],
  ): Promise<SendResult>;
  /** Answers the question set `ask` waiting in that space (`answer_space`). */
  answerSpace(
    hostDevice: string,
    space: string,
    ask: string,
    answers: string[][],
  ): Promise<void>;
  /**
   * Seals `file` for `hostDevice`'s pinned key and uploads its chunks
   * (docs/fleet.md "Files (blobs)"): the reference to attach to a start,
   * send or send_to to that computer. `onProgress` gets 0…1.
   */
  uploadAttachment(
    hostDevice: string,
    file: FileToSend,
    onProgress?: (fraction: number) => void,
  ): Promise<BlobRef>;
  /** Removes a blob from the cloud (an attachment taken back before sending). */
  deleteBlob(blobId: string): Promise<void>;
  /**
   * Asks `hostDevice` for a file of `space`'s worktree (`read_file`): the
   * host seals it for this device and uploads it; the reference comes back
   * (`fetchBlob` reads it). Refused over `maxBytes` (≤ 50 MiB) with
   * `fleet.too_large`.
   */
  readFile(
    hostDevice: string,
    space: string,
    path: string,
    maxBytes?: number,
  ): Promise<BlobRef>;
  /** Whether this device's key can open blobs (not a WebCrypto key). */
  canOpenBlobs(): Promise<boolean>;
  /** Downloads a blob's chunks, opens them with this device's key, deletes
   *  the blob from the cloud: the plaintext. `onProgress` gets 0…1. */
  fetchBlob(
    ref: BlobRef,
    onProgress?: (fraction: number) => void,
  ): Promise<Uint8Array>;
}
