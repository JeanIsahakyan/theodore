/**
 * Devices trusted here (docs/fleet.md "Trust"): `{deviceId, publicKey,
 * name}`, the key exactly as the user compared it, the name sanitized when
 * pinned. Kept in secure storage, one entry per pin (secure-store values
 * stay small) plus an index of ids.
 */
import { storageKey, type SecretStorage } from '../keys/storage-types';
import { pinName, validDeviceId } from './rules';

export interface Pin {
  deviceId: string;
  publicKey: string;
  name: string;
}

const INDEX = 'theodore.fleet.pins';
const pinKey = (id: string) => storageKey('theodore.fleet.pin', id);

export interface PinStore {
  list(): Promise<Pin[]>;
  get(deviceId: string): Promise<Pin | null>;
  put(pin: Pin): Promise<void>;
  remove(deviceId: string): Promise<void>;
}

export function pinStore(storage: SecretStorage): PinStore {
  let cache: Promise<Map<string, Pin>> | null = null;

  const load = async (): Promise<Map<string, Pin>> => {
    const out = new Map<string, Pin>();
    let ids: unknown = [];
    try {
      ids = JSON.parse((await storage.get(INDEX)) ?? '[]');
    } catch {
      ids = [];
    }
    for (const id of Array.isArray(ids) ? ids : []) {
      if (!validDeviceId(id)) continue;
      try {
        const p = JSON.parse(
          (await storage.get(pinKey(id))) ?? 'null',
        ) as Partial<Pin> | null;
        if (p && p.deviceId === id && typeof p.publicKey === 'string') {
          // Sanitized when read too, for pins made by an older build.
          out.set(id, {
            deviceId: id,
            publicKey: p.publicKey,
            name: pinName(typeof p.name === 'string' ? p.name : ''),
          });
        }
      } catch {
        // An unreadable pin is no pin: trust has to be given again.
      }
    }
    return out;
  };

  const pins = () => {
    cache ??= load().catch((e: unknown) => {
      cache = null;
      throw e;
    });
    return cache;
  };

  const saveIndex = (m: Map<string, Pin>) =>
    storage.set(INDEX, JSON.stringify([...m.keys()]));

  return {
    list: async () => [...(await pins()).values()],
    get: async (id) => (await pins()).get(id) ?? null,
    async put(pin) {
      const m = await pins();
      await storage.set(pinKey(pin.deviceId), JSON.stringify(pin));
      m.set(pin.deviceId, pin);
      await saveIndex(m);
    },
    async remove(id) {
      const m = await pins();
      m.delete(id);
      await saveIndex(m);
      await storage.remove(pinKey(id));
    },
  };
}
