/**
 * Everything in `Ephemeral` (agent token stream, skill run log lines, toasts,
 * host status) — never synced, kept only in memory per §3.2 of the plan.
 */
import {
  computed,
  makeObservable,
  observable,
  observableRef,
  observableShallow,
  runInAction,
} from 'mobx';
import type {
  AccountStatus,
  AppInfo,
  CommentId,
  Ephemeral,
  PrId,
  Person,
  SandboxInfo,
  SpaceLogLine,
  ToastLevel,
} from '../gen/contract';
import { appendLogs, seedLogs } from '../ui/space/commands';
import { configPrToast } from '../ui/project/configFile';
import { openExternal } from '../core/openExternal';
import { accountGate, type AccountGate } from '../core/accountGate';

const LOG_LIMIT = 500;

export interface ToastAction {
  label: string;
  onAction: () => void;
}

export interface Toast {
  id: number;
  level: ToastLevel;
  text: string;
  /** e.g. "Undo" after a Done/Snooze/Archive-type action — never set by the
   *  `ephemeral` event from core, only by client code that pushes its own
   *  toast (a function can't cross the wire). */
  action?: ToastAction;
}

export interface HostStatus {
  online: boolean;
  rateLimitedUntil: number | null;
  authOk: boolean;
}

export class EphemeralStore {
  /** Streaming text per run id, appended as `agent_delta` events arrive. */
  agentText = new Map<string, string>();
  /** Last lines of a skill run's log, per run id. */
  runLog = new Map<string, string[]>();
  /** Run ids with no output for `agents.stall_after_ms` while still alive —
   *  the UI offers Retry/Cancel instead of waiting silently. Cleared as
   *  soon as the run produces output again, or ends. */
  stalled = new Set<string>();
  toasts: Toast[] = [];
  hostStatus: HostStatus = {
    online: true,
    rateLimitedUntil: null,
    authOk: true,
  };
  /** `refresh_inbox` in flight. */
  inboxLoading = false;
  /** Grouping runs in flight (and the last error) per PR id. */
  grouping = new Map<string, { running: boolean; error: string | null }>();
  /** The authenticated host user, cached once fetched via `viewer`. */
  viewer: Person | null = null;
  /** `viewer` fetch in flight — tells "loading" apart from "signed out". */
  viewerLoading = false;
  /** `app_info`, fetched once at startup; `null` until it arrives. */
  appInfo: AppInfo | null = null;
  /** The Theodore account, from `account_status` and its `account_status`
   *  event; `null` until first fetched. */
  account: AccountStatus | null = null;
  /** Optimistic overlay on `Comment.reactions`, `"<comment>:<emoji>"` ->
   *  the viewer-reacted state we just set. Wins over the server's
   *  `viewer_reacted`/`count` until the next sync brings a `Comment` whose
   *  server state already matches, at which point the caller clears it
   *  (`clearReactionOverride`) — it's then redundant, not a second source
   *  of truth. */
  reactionOverrides = new Map<string, boolean>();
  /** Suggestion comments queued for a batch commit, per PR. */
  suggestionBatch = new Map<PrId, Set<CommentId>>();
  /** A space's command output (setup / run / check / archive), per space
   *  id: live `space_log` events, seeded from `space_logs` when its page
   *  opens. Bounded (`SPACE_LOG_LIMIT`). */
  spaceLogs = new Map<string, SpaceLogLine[]>();

  private nextToastId = 1;

  constructor() {
    makeObservable(this, {
      agentText: observableShallow,
      runLog: observableShallow,
      stalled: observableShallow,
      toasts: observableShallow,
      hostStatus: observable,
      grouping: observableShallow,
      inboxLoading: observable,
      viewer: observableRef,
      viewerLoading: observable,
      appInfo: observableRef,
      account: observableRef,
      accountGate: computed,
      sandbox: computed,
      reactionOverrides: observableShallow,
      suggestionBatch: observableShallow,
      spaceLogs: observableShallow,
    });
  }

  reactionOverride(comment: CommentId, emoji: string): boolean | undefined {
    return this.reactionOverrides.get(`${comment}:${emoji}`);
  }

  setReactionOverride(comment: CommentId, emoji: string, on: boolean): void {
    runInAction(() => {
      const next = new Map(this.reactionOverrides);
      next.set(`${comment}:${emoji}`, on);
      this.reactionOverrides = next;
    });
  }

  /** Drops the override once the server's own data agrees with it — kept
   *  around any longer it would just be stale local state shadowing real
   *  sync data. */
  clearReactionOverride(comment: CommentId, emoji: string): void {
    const key = `${comment}:${emoji}`;
    if (!this.reactionOverrides.has(key)) return;
    runInAction(() => {
      const next = new Map(this.reactionOverrides);
      next.delete(key);
      this.reactionOverrides = next;
    });
  }

  batchOf(pr: PrId): Set<CommentId> {
    return this.suggestionBatch.get(pr) ?? new Set();
  }

  toggleBatch(pr: PrId, comment: CommentId): void {
    runInAction(() => {
      const next = new Map(this.suggestionBatch);
      const set = new Set(next.get(pr) ?? []);
      if (set.has(comment)) set.delete(comment);
      else set.add(comment);
      next.set(pr, set);
      this.suggestionBatch = next;
    });
  }

  clearBatch(pr: PrId, comments?: CommentId[]): void {
    runInAction(() => {
      const next = new Map(this.suggestionBatch);
      if (!comments) {
        next.delete(pr);
      } else {
        const set = new Set(next.get(pr) ?? []);
        for (const c of comments) set.delete(c);
        next.set(pr, set);
      }
      this.suggestionBatch = next;
    });
  }

  setInboxLoading(v: boolean): void {
    runInAction(() => {
      this.inboxLoading = v;
    });
  }

  setViewerLoading(v: boolean): void {
    runInAction(() => {
      this.viewerLoading = v;
    });
  }

  setAppInfo(info: AppInfo): void {
    runInAction(() => {
      this.appInfo = info;
    });
  }

  /** Set only when this window runs against the sandbox host. */
  get sandbox(): SandboxInfo | null {
    return this.appInfo?.sandbox ?? null;
  }

  /** `locked` while signed out where signing in is required: only the
   *  sign-in shows, shortcuts and the menu are inert. */
  get accountGate(): AccountGate {
    return accountGate(this.account);
  }

  setAccount(s: AccountStatus): void {
    runInAction(() => {
      this.account = s;
    });
  }

  setViewer(p: Person): void {
    runInAction(() => {
      this.viewer = p;
    });
  }

  handle(e: Ephemeral): void {
    runInAction(() => {
      switch (e.type) {
        case 'agent_delta': {
          const next = new Map(this.agentText);
          next.set(e.run, (next.get(e.run) ?? '') + e.text);
          this.agentText = next;
          this.clearStalled(e.run);
          return;
        }
        case 'run_log': {
          const next = new Map(this.runLog);
          const lines = [...(next.get(e.run) ?? []), e.line].slice(-LOG_LIMIT);
          next.set(e.run, lines);
          this.runLog = next;
          this.clearStalled(e.run);
          return;
        }
        case 'run_stalled': {
          const next = new Set(this.stalled);
          next.add(e.run);
          this.stalled = next;
          return;
        }
        case 'toast':
          this.toasts = [
            ...this.toasts,
            { id: this.nextToastId++, level: e.level, text: e.text },
          ];
          return;
        case 'grouping': {
          const next = new Map(this.grouping);
          next.set(e.pr, { running: e.running, error: e.error });
          this.grouping = next;
          return;
        }
        case 'host_status':
          this.hostStatus = {
            online: e.online,
            rateLimitedUntil: e.rate_limited_until,
            authOk: e.auth_ok,
          };
          return;
        case 'account_status':
          this.account = e.status;
          return;
        case 'space_log': {
          const next = new Map(this.spaceLogs);
          next.set(e.space, appendLogs(next.get(e.space) ?? [], [e.line]));
          this.spaceLogs = next;
          return;
        }
        case 'config_pr': {
          const toast = configPrToast(e.number, e.url, openExternal);
          this.toasts = [
            ...this.toasts,
            { id: this.nextToastId++, level: 'info', ...toast },
          ];
          return;
        }
      }
    });
  }

  /** The core's tail (`space_logs`) for a space, merged with the live
   *  lines that arrived while it was fetched. */
  seedSpaceLogs(space: string, lines: SpaceLogLine[]): void {
    runInAction(() => {
      const next = new Map(this.spaceLogs);
      next.set(space, seedLogs(lines, next.get(space) ?? []));
      this.spaceLogs = next;
    });
  }

  /** Pushes a toast from client code (as opposed to `handle()`'s server
   *  `toast` events) — the only path that can attach an `action`. */
  toast(text: string, level: ToastLevel = 'info', action?: ToastAction): void {
    runInAction(() => {
      this.toasts = [
        ...this.toasts,
        { id: this.nextToastId++, level, text, action },
      ];
    });
  }

  dismissToast(id: number): void {
    runInAction(() => {
      this.toasts = this.toasts.filter((t) => t.id !== id);
    });
  }

  /** A run is done (or cancelled/failed): its streaming text and log no longer grow. */
  clearRun(run: string): void {
    runInAction(() => {
      const text = new Map(this.agentText);
      text.delete(run);
      this.agentText = text;
      const log = new Map(this.runLog);
      log.delete(run);
      this.runLog = log;
      this.clearStalled(run);
    });
  }

  private clearStalled(run: string): void {
    if (!this.stalled.has(run)) return;
    const next = new Set(this.stalled);
    next.delete(run);
    this.stalled = next;
  }
}
