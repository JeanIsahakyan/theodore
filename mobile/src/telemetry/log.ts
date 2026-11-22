/**
 * The app's logger and the hub of its telemetry (docs/telemetry.md
 * "Mobile"): one record, one redaction step, three sinks.
 *
 * ```text
 * log.debug/info/warn/error(msg, fields)  ─┐
 * track(event, props)   kind product       ─┼─▶ redact (local) ─▶ ring   always, on device
 * reportError(code, e)  kind error         ─┘       │
 *                                                   ├─▶ redact (remote: names hashed)
 *                                                   │     ├─▶ PostHog   product, "Share usage data"
 *                                                   │     └─▶ relay     warn+, "Send error reports"
 * before configure()   ─▶ ring in memory only, nothing remote
 * no choice recorded   ─▶ nothing sent, nothing queued (dropped)
 * a switch turned off  ─▶ its sink stops at once, its queue is dropped
 * ```
 *
 * `configure()` is called once by the app shell (`src/telemetry/setup.ts`)
 * with the platform's storage, facts and sinks; tests build their own
 * instance with `createTelemetry()`.
 */
import { memoryStorage } from '../keys/storage-types';
import type { DataStorage } from '../fleet/data';
import {
  allowedProps,
  isCatalogEvent,
  type EventName,
  type EventProps,
} from './catalog';
import {
  consentStore,
  chosen,
  linksUsage,
  NO_CHOICE,
  useConsent,
  type Choice,
  type ConsentStore,
} from './consent';
import { loadIdentity, type Identity } from './identity';
import { createPostHog, type PostHogSink } from './posthog';
import { errorFields, redactRecord } from './redact';
import { createRelay, type RelaySink } from './relay';
import { createRing, type Ring } from './ring';
import {
  LEVEL_RANK,
  type AppFacts,
  type Fields,
  type Level,
  type TelemetryRecord,
} from './types';

export interface TelemetryDeps {
  storage: DataStorage;
  facts: AppFacts;
  randomUUID: () => string;
  fetch: typeof fetch;
  /** `null`: the build has no PostHog key; the usage sink is off. */
  posthog: { host: string; key: string } | null;
  /** The Theodore cloud, which relays error reports to New Relic. */
  cloudUrl: string;
  /** The session JWT when signed in. */
  token: () => Promise<string | null>;
  /** Lowest level kept in the local log (default `info`). */
  minLevel?: Level;
  /** Dev builds: every record also goes here (the console). */
  mirror?: (r: TelemetryRecord) => void;
  now?: () => number;
  random?: () => number;
  /** Tests: faster batches. */
  flushMs?: number;
  ringSaveDelayMs?: number;
}

export interface TelemetryStatus {
  configured: boolean;
  /** The build can send usage data (a PostHog key). */
  usageAvailable: boolean;
  /** The build can send error reports (always: the cloud relays them). */
  errorsAvailable: boolean;
  choice: Choice;
  installId: string | null;
}

export type LogFn = (msg: string, fields?: Fields) => void;

export interface Logger {
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
}

export class Telemetry {
  private deps: TelemetryDeps | null = null;
  private ring: Ring = createRing(memoryStorage());
  private identity: Identity | null = null;
  private consent: ConsentStore | null = null;
  private posthog: PostHogSink | null = null;
  private relay: RelaySink | null = null;
  private key = 'unconfigured';
  private identified: string | null = null;
  private ready: Promise<void> | null = null;
  private minLevel: Level = 'info';
  private readonly startedAt = Date.now();

  /** Field-style logging: `log.info('fleet connected', {ms: 120})`. */
  readonly log: Logger = {
    debug: (msg, fields) => this.emit('debug', 'log', msg, fields),
    info: (msg, fields) => this.emit('info', 'log', msg, fields),
    warn: (msg, fields) => this.emit('warn', 'log', msg, fields),
    error: (msg, fields) => this.emit('error', 'log', msg, fields),
  };

  /** Wires storage, identity, the choice and the sinks. Once. */
  configure(deps: TelemetryDeps): Promise<void> {
    if (this.ready) return this.ready;
    this.deps = deps;
    this.minLevel = deps.minLevel ?? 'info';
    const memory = this.ring;
    this.ring = createRing(deps.storage, { saveDelayMs: deps.ringSaveDelayMs });
    this.ready = (async () => {
      await this.ring.load();
      // What was logged before the store was ready, in order.
      for (const r of memory.records()) this.ring.push(r);
      this.identity = await loadIdentity(deps.storage, deps.randomUUID);
      this.key = this.identity.installId();
      this.consent = consentStore(deps.storage, (c) => this.onChoice(c));
      const choice = await this.consent.load();
      const facts = deps.facts;
      if (deps.posthog && deps.posthog.key) {
        this.posthog = createPostHog({
          host: deps.posthog.host,
          key: deps.posthog.key,
          facts,
          fetch: deps.fetch,
          flushMs: deps.flushMs,
          now: deps.now,
          random: deps.random,
        });
      }
      this.relay = createRelay({
        cloudUrl: deps.cloudUrl,
        facts,
        installId: () => this.identity?.installId() ?? '',
        enduser: () =>
          this.identity?.errorsAccount(useConsent.getState().choice) ?? null,
        token: deps.token,
        fetch: deps.fetch,
        flushMs: deps.flushMs,
        now: deps.now,
        random: deps.random,
      });
      await this.maybeIdentify(choice);
    })();
    return this.ready;
  }

  whenReady(): Promise<void> {
    return this.ready ?? Promise.resolve();
  }

  private now(): number {
    return this.deps?.now?.() ?? Date.now();
  }

  /** A fresh correlation id (16 hex) for a request flow. */
  newOpId(): string {
    const raw = (this.deps?.randomUUID ?? fallbackUUID)().replace(/-/g, '');
    return raw.slice(0, 16).padEnd(16, '0');
  }

  /** Milliseconds since `start` (a `now()` taken earlier). */
  since(start: number): number {
    return Math.max(0, Math.round(this.now() - start));
  }

  status(): TelemetryStatus {
    return {
      configured: this.deps !== null,
      usageAvailable: !!this.deps?.posthog?.key,
      errorsAvailable: this.deps !== null,
      choice: useConsent.getState().choice,
      installId: this.identity?.installId() ?? null,
    };
  }

  // ── writing ───────────────────────────────────────────────────────────

  private emit(
    level: Level,
    kind: TelemetryRecord['kind'],
    msg: string,
    fields: Fields = {},
    extra: { event?: string; op_id?: string } = {},
  ): void {
    const opId =
      extra.op_id ??
      (typeof fields.op_id === 'string' ? fields.op_id : undefined);
    const rest: Fields = {};
    for (const [k, v] of Object.entries(fields)) {
      if (k === 'op_id' || v === undefined) continue;
      rest[k] = v;
    }
    const raw: TelemetryRecord = {
      ts: this.now(),
      level,
      kind,
      msg,
      fields: rest,
    };
    if (opId) raw.op_id = opId;
    if (extra.event) raw.event = extra.event;
    const local = redactRecord(raw, { key: this.key, remote: false });
    this.deps?.mirror?.(local);
    if (LEVEL_RANK[level] >= LEVEL_RANK[this.minLevel]) this.ring.push(local);
    this.remote(local);
  }

  private remote(local: TelemetryRecord): void {
    if (!this.deps || !this.identity) return;
    const choice = useConsent.getState().choice;
    if (!chosen(choice)) return;
    let remote: TelemetryRecord | null = null;
    const redacted = () =>
      (remote ??= redactRecord(local, { key: this.key, remote: true }));
    if (
      local.kind === 'product' &&
      local.event &&
      choice.usage &&
      this.posthog
    ) {
      const account = this.identity.usageAccount(choice);
      this.posthog.capture(
        local.event,
        account ?? this.identity.anonId(),
        account === null,
        local.ts,
        redacted().fields,
      );
    }
    if (
      choice.errors &&
      this.relay &&
      LEVEL_RANK[local.level] >= LEVEL_RANK.warn
    ) {
      this.relay.push(redacted());
    }
  }

  /** A product event from the catalog; unknown events and props are dropped. */
  track<E extends EventName>(event: E, props: EventProps<E> = {}): void {
    if (!isCatalogEvent(event)) {
      this.log.warn('product event not in the catalog', {
        event: String(event),
      });
      return;
    }
    const fields = allowedProps(event, props as Record<string, unknown>);
    this.emit('info', 'product', event, fields, { event });
  }

  /**
   * A failure with a stable `error.code` (`ui.uncaught`, `fleet.request`,
   * …): warn (expected failures) or error (crashes), the thrown value's
   * message and stack as fields.
   */
  reportError(
    code: string,
    e: unknown,
    fields: Fields = {},
    level: 'warn' | 'error' = 'error',
  ): void {
    const { msg, ...rest } = fields;
    this.emit(level, 'error', typeof msg === 'string' ? msg : code, {
      ...errorFields(e),
      ...rest,
      'error.code': code,
    });
  }

  // ── identity and consent ──────────────────────────────────────────────

  /** Sign-in (a `user_…` id) or sign-out (`null`). */
  async setAccount(id: string | null): Promise<void> {
    await this.whenReady();
    if (!this.identity) return;
    const before = this.identity.account();
    this.identity.setAccount(id);
    const after = this.identity.account();
    if (before && !after) {
      // Signed out: later events aren't linked to that person.
      this.identified = null;
      await this.identity.rotateAnon();
      this.log.info('signed out of the Theodore account');
    } else if (after && after !== before) {
      await this.maybeIdentify(useConsent.getState().choice);
    }
  }

  /** Settings, the card: records the switches named. */
  async setChoice(next: {
    usage?: boolean;
    errors?: boolean;
  }): Promise<Choice> {
    await this.whenReady();
    if (!this.consent) return NO_CHOICE;
    return this.consent.set(next);
  }

  private onChoice(c: Choice): void {
    if (!c.usage) {
      this.posthog?.clear();
      this.identified = null;
    }
    if (!c.errors) this.relay?.clear();
    if (c.usage) void this.maybeIdentify(c);
  }

  /** `$identify` once per account while usage data may carry it. */
  private async maybeIdentify(choice: Choice): Promise<void> {
    if (!this.identity || !this.posthog) return;
    const account = this.identity.usageAccount(choice);
    if (!account || !linksUsage(choice) || this.identified === account) return;
    this.identified = account;
    // Linking starts from a new anonymous id: what the install id sent
    // stays unlinked.
    const anon =
      this.identity.anonId() === this.identity.installId()
        ? await this.identity.rotateAnon()
        : this.identity.anonId();
    this.posthog.identify(account, anon, this.now());
    this.log.info('telemetry linked to the account');
  }

  // ── the local log ─────────────────────────────────────────────────────

  /** The ring, oldest first (already redacted with the local rules). */
  records(): TelemetryRecord[] {
    return this.ring.records();
  }

  /**
   * The local log as text for a problem report: one JSON object per line,
   * the remote rules applied again (names and paths hashed), newest last.
   */
  exportText(): string {
    const lines = this.records().map((r) =>
      JSON.stringify(redactRecord(r, { key: this.key, remote: true })),
    );
    return lines.join('\n');
  }

  /** Writes the ring and sends what waits (the app leaving the foreground). */
  async flush(): Promise<void> {
    await Promise.all([
      this.ring.flush(),
      this.posthog?.flush() ?? Promise.resolve(),
      this.relay?.flush() ?? Promise.resolve(),
    ]);
  }

  /** Tests. */
  sinks(): { posthog: PostHogSink | null; relay: RelaySink | null } {
    return { posthog: this.posthog, relay: this.relay };
  }

  /** Tests: everything stored and chosen is gone; the instance stays usable. */
  async resetForTests(): Promise<void> {
    await this.consent?.reset();
    await this.ring.clear();
    this.posthog?.clear();
    this.relay?.clear();
    this.identified = null;
  }

  /** Milliseconds since this instance was made (app start). */
  uptime(): number {
    return this.since(this.startedAt);
  }
}

function fallbackUUID(): string {
  const c = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (c?.randomUUID) return c.randomUUID();
  let out = '';
  for (let i = 0; i < 32; i++)
    out += Math.floor(Math.random() * 16).toString(16);
  return out;
}

/** A fresh instance (tests). */
export function createTelemetry(): Telemetry {
  return new Telemetry();
}

/** The app's one instance. */
export const telemetry: Telemetry = new Telemetry();

export const log: Logger = telemetry.log;

/** `track('space_started', {mode: 'edit'})`: a catalog event. */
export function track<E extends EventName>(
  event: E,
  props?: EventProps<E>,
): void {
  telemetry.track(event, props);
}

/** A failure with a stable `error.code`. */
export const reportError: Telemetry['reportError'] = (code, e, fields, level) =>
  telemetry.reportError(code, e, fields, level);

export const newOpId = (): string => telemetry.newOpId();
