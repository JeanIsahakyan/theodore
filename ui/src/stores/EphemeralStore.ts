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
import type { Ephemeral, Person, ToastLevel } from '../gen/contract';

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
  /** Grouping runs in flight (and the last error) per PR id. */
  grouping = new Map<string, { running: boolean; error: string | null }>();
  /** The authenticated host user, cached once fetched via `viewer`. */
  viewer: Person | null = null;

  private nextToastId = 1;

  constructor() {
    makeObservable(this, {
      agentText: observableShallow,
      runLog: observableShallow,
      toasts: observableShallow,
      hostStatus: observable,
      grouping: observableShallow,
      viewer: observableRef,
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
