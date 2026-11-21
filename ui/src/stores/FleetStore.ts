/**
 * The fleet in memory (docs/fleet.md): this device's connection and the
 * list of devices, the spaces started on other devices (or hosted here for
 * them), the questions routed to this device, the "wants to run spaces
 * here" notices and the requests from Claude via the cloud waiting for a
 * yes. Fed by the `fleet_*` ephemerals and by the commands' own
 * replies; never synced. A remote space itself is an ordinary `space` row
 * (mirrored, `Space.remote` set): its chat and page are the usual ones.
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
  FleetAutoOn,
  FleetAutoRequest,
  FleetConfirm,
  FleetDevice,
  FleetQuestion,
  FleetRemoteSpace,
  FleetStatus,
  FleetTrustNeeded,
} from '../gen/contract';
import { api } from '../core/api';

export class FleetStore {
  /** `null` until `fleet_status` was read (or when it can't be). */
  status: FleetStatus | null = null;
  /** Every fleet space known, by its fleet id: what a space just started
   *  elsewhere says until its mirrored row comes. */
  readonly spaces = observable.map<string, FleetRemoteSpace>(
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

  /** Requests from Claude via the cloud waiting for your yes, by id. */
  readonly confirms = observable.map<string, FleetConfirm>({}, { deep: false });

  /** Decision prompts (a request above, a "wants to run spaces here") put
   *  away unanswered — Esc or a click outside their dialog — by prompt
   *  key. The dialog stays shut until one not among them comes, or the
   *  reminder in the tab bar opens it again. */
  readonly promptsAway = observable.set<string>();

  constructor() {
    makeObservable(this, {
      status: observableRef,
      available: computed,
      enabled: computed,
      devices: computed,
      thisDevice: computed,
      askList: computed,
      trustNeededList: computed,
      confirmList: computed,
      autos: computed,
      handle: action,
      setConfirms: action,
      dropConfirm: action,
      setStatus: action,
      setSpaces: action,
      upsertSpace: action,
      dismissTrustNeeded: action,
      dropAsk: action,
      putAwayPrompts: action,
      reopenPrompts: action,
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

  get askList(): FleetQuestion[] {
    return [...this.asks.values()];
  }

  get trustNeededList(): FleetTrustNeeded[] {
    return [...this.trustNeeded.values()];
  }

  /** Waiting for your yes, the one running out first on top. */
  get confirmList(): FleetConfirm[] {
    return [...this.confirms.values()].sort(
      (a, b) => a.expires_at_ms - b.expires_at_ms,
    );
  }

  /** Auto modes on now on this computer (Claude via cloud skips your
   *  yes): the notice that stays while one lasts. */
  get autos(): FleetAutoOn[] {
    return this.status?.autos ?? [];
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
        // The history is the mirrored space's own chat now.
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
      case 'fleet_confirm':
        this.confirms.set(e.request.id, e.request);
        return true;
      case 'fleet_confirm_done':
        this.confirms.delete(e.id);
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

  dismissTrustNeeded(deviceId: string): void {
    this.trustNeeded.delete(deviceId);
  }

  dropAsk(askId: string): void {
    this.asks.delete(askId);
  }

  setConfirms(list: FleetConfirm[]): void {
    this.confirms.replace(new Map(list.map((c) => [c.id, c])));
  }

  dropConfirm(id: string): void {
    this.confirms.delete(id);
  }

  /** Puts the decision dialog away with these prompts in it, unanswered. */
  putAwayPrompts(keys: readonly string[]): void {
    this.promptsAway.replace(keys);
  }

  /** The reminder's click: the dialog shows every prompt waiting again. */
  reopenPrompts(): void {
    this.promptsAway.clear();
  }

  /** Allow or Deny a request waiting here. It goes at once; one that
   *  isn't waiting any more (answered elsewhere, out of time) just goes. */
  async confirm(id: string, allow: boolean): Promise<void> {
    try {
      await api.fleetConfirm({ id, allow });
    } finally {
      this.dropConfirm(id);
    }
  }

  /** Auto mode for Claude via cloud, here or (`host_device`) on another
   *  computer; answered with the new status. */
  async setAuto(req: FleetAutoRequest): Promise<void> {
    this.setStatus(await api.fleetSetAuto(req));
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
    try {
      this.setConfirms(await api.fleetConfirms());
    } catch {
      // Quiet: new ones still come as events.
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

  /** "Send my spaces' questions here" on a trusted phone or web app, or
   *  off. Answered with the new status. */
  async delegate(deviceId: string, on: boolean): Promise<void> {
    this.setStatus(await api.fleetDelegate(deviceId, on));
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
