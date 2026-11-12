/**
 * The fleet in memory (docs/fleet.md): this device's connection and the
 * list of devices, the spaces started on other devices (or hosted here for
 * them), each one's lines, the questions routed to this device and the
 * "wants to run spaces here" notices. Fed by the `fleet_*` ephemerals and
 * by the commands' own replies; never synced.
 */
import {
  action,
  computed,
  makeObservable,
  observable,
  observableRef,
} from 'mobx';
import type {
  Ephemeral,
  FleetDevice,
  FleetQuestion,
  FleetRemoteSpace,
  FleetSpaceLine,
  FleetStatus,
  FleetTrustNeeded,
} from '../gen/contract';
import { api } from '../core/api';

/** As many lines of one space as the host journals. */
export const LINE_LIMIT = 2000;

/** `lines` plus `incoming`, by `seq`: a line already held is replaced,
 *  order is by `seq`, and only the newest `LINE_LIMIT` stay. */
export function mergeLines(
  lines: readonly FleetSpaceLine[],
  incoming: readonly FleetSpaceLine[],
): FleetSpaceLine[] {
  if (incoming.length === 0) return lines.slice();
  const bySeq = new Map<number, FleetSpaceLine>();
  for (const l of lines) bySeq.set(l.seq, l);
  for (const l of incoming) bySeq.set(l.seq, l);
  const all = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  return all.length > LINE_LIMIT ? all.slice(all.length - LINE_LIMIT) : all;
}

export class FleetStore {
  /** `null` until `fleet_status` was read (or when it can't be). */
  status: FleetStatus | null = null;
  /** Every fleet space known, by its fleet id. */
  readonly spaces = observable.map<string, FleetRemoteSpace>(
    {},
    { deep: false },
  );
  /** A space's lines, in `seq` order. */
  readonly lines = observable.map<string, FleetSpaceLine[]>(
    {},
    { deep: false },
  );
  /** Questions routed to this device, by `ask_id`. */
  readonly asks = observable.map<string, FleetQuestion>({}, { deep: false });
  /** Devices that asked to run a space here and aren't trusted, by id. */
  readonly trustNeeded = observable.map<string, FleetTrustNeeded>(
    {},
    { deep: false },
  );

  constructor() {
    makeObservable(this, {
      status: observableRef,
      available: computed,
      enabled: computed,
      devices: computed,
      thisDevice: computed,
      spaceList: computed,
      askList: computed,
      trustNeededList: computed,
      handle: action,
      setStatus: action,
      setSpaces: action,
      upsertSpace: action,
      addLines: action,
      dismissTrustNeeded: action,
      dropAsk: action,
    });
  }

  /** The cloud and an account are configured: the feature shows. */
  get available(): boolean {
    return this.status?.available === true;
  }

  get enabled(): boolean {
    return this.available && this.status?.enabled === true;
  }

  get devices(): FleetDevice[] {
    return this.status?.devices ?? [];
  }

  get thisDevice(): FleetDevice | undefined {
    return this.devices.find((d) => d.this_device);
  }

  /** In the order they were learned, those waiting for you first, then
   *  those running. */
  get spaceList(): FleetRemoteSpace[] {
    const rank = (s: FleetRemoteSpace) =>
      s.question || s.status === 'waiting'
        ? 0
        : s.status === 'running' || s.status === 'starting'
          ? 1
          : 2;
    return [...this.spaces.values()]
      .map((s, i) => ({ s, i }))
      .sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i)
      .map((x) => x.s);
  }

  get askList(): FleetQuestion[] {
    return [...this.asks.values()];
  }

  get trustNeededList(): FleetTrustNeeded[] {
    return [...this.trustNeeded.values()];
  }

  /** The question open on a space: the one on the space itself, else a
   *  routed one about it. */
  questionOf(space: string): FleetQuestion | null {
    const own = this.spaces.get(space)?.question;
    if (own) return own;
    return this.askList.find((q) => q.space === space) ?? null;
  }

  device(id: string): FleetDevice | undefined {
    return this.devices.find((d) => d.device_id === id);
  }

  /** One `fleet_*` event. `false` for anything else. */
  handle(e: Ephemeral): boolean {
    switch (e.type) {
      case 'fleet_status':
        this.setStatus(e.status);
        return true;
      case 'fleet_space':
        this.upsertSpace(e.space);
        return true;
      case 'fleet_space_line':
        this.addLines(e.space, [e.line]);
        return true;
      case 'fleet_ask':
        this.asks.set(e.question.ask_id, e.question);
        return true;
      case 'fleet_ask_dismissed': {
        this.asks.delete(e.ask_id);
        // The same question sitting on its space is answered too.
        for (const s of [...this.spaces.values()]) {
          if (s.question?.ask_id === e.ask_id) {
            this.spaces.set(s.space, { ...s, question: null });
          }
        }
        return true;
      }
      case 'fleet_trust_needed':
        this.trustNeeded.set(e.request.device_id, e.request);
        return true;
      default:
        return false;
    }
  }

  setStatus(status: FleetStatus): void {
    this.status = status;
    // A device trusted from anywhere needs no notice any more.
    for (const d of status.devices) {
      if (d.trusted) this.trustNeeded.delete(d.device_id);
    }
  }

  setSpaces(spaces: FleetRemoteSpace[]): void {
    this.spaces.replace(new Map(spaces.map((s) => [s.space, s])));
  }

  upsertSpace(space: FleetRemoteSpace): void {
    this.spaces.set(space.space, space);
  }

  addLines(space: string, incoming: FleetSpaceLine[]): void {
    this.lines.set(space, mergeLines(this.lines.get(space) ?? [], incoming));
  }

  dismissTrustNeeded(deviceId: string): void {
    this.trustNeeded.delete(deviceId);
  }

  dropAsk(askId: string): void {
    this.asks.delete(askId);
  }

  /** `fleet_status`, then (with a fleet) `fleet_spaces`. A failure leaves
   *  the feature hidden: the core says why in `status.error`. */
  async load(): Promise<void> {
    try {
      this.setStatus(await api.fleetStatus());
    } catch {
      return;
    }
    if (!this.available) return;
    try {
      this.setSpaces(await api.fleetSpaces());
    } catch {
      // Quiet: the list stays as it was.
    }
  }

  /** A space's history, loaded when it is opened: what the core has after
   *  the last line held, merged with the ones that arrived meanwhile. */
  async loadLines(space: string): Promise<void> {
    const held = this.lines.get(space) ?? [];
    const since = held.length ? held[held.length - 1]!.seq : 0;
    try {
      this.addLines(space, await api.fleetSpaceLines(space, since));
    } catch {
      // Quiet: the live lines still come.
    }
  }

  /** Settings → Devices: a change, answered with the new status. */
  async setSettings(
    req: Parameters<typeof api.fleetSetSettings>[0],
  ): Promise<void> {
    this.setStatus(await api.fleetSetSettings(req));
  }

  /** Pins `publicKey` — the key of the fingerprint the user compared — as
   *  the device's here. The core refuses it if the cloud now lists another
   *  key for the device (toasted by api.ts, like any command error). */
  async trust(deviceId: string, publicKey: string): Promise<void> {
    this.setStatus(
      await api.fleetTrustDevice({
        device_id: deviceId,
        trusted: true,
        public_key: publicKey,
      }),
    );
    this.dismissTrustNeeded(deviceId);
  }

  /** Unpins a device's key here. */
  async untrust(deviceId: string): Promise<void> {
    this.setStatus(
      await api.fleetTrustDevice({
        device_id: deviceId,
        trusted: false,
        public_key: null,
      }),
    );
  }

  /** Signs another device out of the fleet; it has to join again as a new
   *  device. Answered with the new status. */
  async remove(deviceId: string): Promise<void> {
    this.setStatus(await api.fleetRemoveDevice(deviceId));
    this.dismissTrustNeeded(deviceId);
  }

  /** Starts a space on another device; it is listed at once. */
  async start(
    req: Parameters<typeof api.fleetStartSpace>[0],
  ): Promise<FleetRemoteSpace> {
    const space = await api.fleetStartSpace(req);
    this.upsertSpace(space);
    return space;
  }

  /** Answers a question. A routed card goes at once; the one on the space
   *  itself goes with the space's next update (or `fleet_ask_dismissed`). */
  async answer(q: FleetQuestion, answers: string[][]): Promise<void> {
    await api.fleetAnswer({ space: q.space, ask_id: q.ask_id, answers });
    this.dropAsk(q.ask_id);
  }
}
