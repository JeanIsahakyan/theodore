/**
 * Everything in `Ephemeral` (agent token stream, skill run log lines, toasts,
 * host status) — never synced, kept only in memory per §3.2 of the plan.
 */
import {
  makeObservable,
  observable,
  observableRef,
  observableShallow,
  runInAction,
} from 'mobx';
import type {
  CommentId,
  Ephemeral,
  PrId,
  Person,
  ToastLevel,
} from '../gen/contract';

const LOG_LIMIT = 500;

export interface Toast {
  id: number;
  level: ToastLevel;
  text: string;
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
  /** Reactions *we* toggled, `"<comment>:<emoji>"` — `Comment` carries no
   *  reaction counts (no field for it in the contract), so this is local
   *  memory of our own toggles, not a readback of the host's state. */
  reacted = new Set<string>();
  /** Suggestion comments queued for a batch commit, per PR. */
  suggestionBatch = new Map<PrId, Set<CommentId>>();

  private nextToastId = 1;

  constructor() {
    makeObservable(this, {
      agentText: observableShallow,
      runLog: observableShallow,
      toasts: observableShallow,
      hostStatus: observable,
      grouping: observableShallow,
      inboxLoading: observable,
      viewer: observableRef,
      viewerLoading: observable,
      reacted: observableShallow,
      suggestionBatch: observableShallow,
    });
  }

  hasReacted(comment: CommentId, emoji: string): boolean {
    return this.reacted.has(`${comment}:${emoji}`);
  }

  setReacted(comment: CommentId, emoji: string, on: boolean): void {
    runInAction(() => {
      const next = new Set(this.reacted);
      const key = `${comment}:${emoji}`;
      if (on) next.add(key);
      else next.delete(key);
      this.reacted = next;
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
          return;
        }
        case 'run_log': {
          const next = new Map(this.runLog);
          const lines = [...(next.get(e.run) ?? []), e.line].slice(-LOG_LIMIT);
          next.set(e.run, lines);
          this.runLog = next;
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
      }
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
    });
  }
}
