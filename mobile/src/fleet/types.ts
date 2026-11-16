/**
 * The fleet as this app sees it (docs/fleet.md, docs/mobile.md). Wire types
 * come from `src/gen/fleet.ts` (generated from Rust; never edited).
 * `FleetClient` is implemented in `src/fleet/client.ts`; screens read the
 * zustand store in `src/state/fleet.ts` and call the client's methods.
 */
import type { FleetMode } from '../gen/fleet';
import type { SpaceMirror } from './mirror';

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

export interface FleetDeviceView {
  deviceId: string;
  name: string;
  /** desktop | daemon | mobile | web */
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

export interface SpaceLine {
  seq: number;
  kind: LineKind;
  text: string;
}

export interface FleetSnapshot {
  connection: ConnectionState;
  error: string | null;
  deviceId: string | null;
  fingerprint: string;
  devices: FleetDeviceView[];
  spaces: SpaceView[];
  lines: Record<string, SpaceLine[]>;
  /** The host's own rows of a space, when it mirrors them (`src/fleet/mirror.ts`). */
  mirrors: Record<string, SpaceMirror>;
  /** Questions routed to this device that aren't answered yet. */
  questions: QuestionView[];
}

export interface FleetClient {
  /** Connects (or reconnects) with the current session; idempotent. */
  start(): Promise<void>;
  stop(): void;
  /** `agent` / `model` / `effort`: only what was picked; the host's
   *  defaults run for the rest. */
  startSpace(
    req: {
      deviceId: string;
      projectId: string;
      goal: string;
      mode: FleetMode;
    } & AgentPicks,
  ): Promise<SpaceView>;
  /** `mode`: the turn's, when it isn't the space's own; `picks`: an agent,
   *  model or effort from this turn on (none: the space's own). */
  send(
    space: string,
    text: string,
    mode?: FleetMode | null,
    picks?: AgentPicks,
  ): Promise<void>;
  stopSpace(space: string): Promise<void>;
  /** One entry per question: chosen options, or one free text. */
  answer(space: string, askId: string, answers: string[][]): Promise<void>;
  /** Pins exactly `publicKey` (refused if the cloud now lists another). */
  trust(deviceId: string, publicKey: string): Promise<void>;
  untrust(deviceId: string): Promise<void>;
  lines(space: string): Promise<SpaceLine[]>;
  registerPush(token: string | null): Promise<void>;
  /** Signs and sends a request without the socket (notification action). */
  answerOverHttp(
    space: string,
    askId: string,
    answers: string[][],
    hostDevice: string,
  ): Promise<void>;
}
