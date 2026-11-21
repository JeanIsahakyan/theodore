import { beforeEach, describe, expect, it } from 'vitest';
import { createDemo, demoOrganizations, demoSession } from '../src/dev/demo';
import { resetFleetState } from '../src/dev/mock';
import { useFleetState } from '../src/state/fleet';

beforeEach(() => resetFleetState());

describe('demo', () => {
  it('starts signed in to a neutral account, store seeded', async () => {
    const { auth } = createDemo();
    expect(await auth.current()).toEqual(demoSession);
    expect(await auth.organizations()).toEqual(demoOrganizations);
    const s = useFleetState.getState();
    expect(s.connection).toBe('connected');
    expect(s.spaces.length).toBeGreaterThan(0);
    const me = s.devices.find((d) => d.thisDevice);
    expect(me?.name).toBe('iPhone');
  });

  it('moves the chat to just before now', () => {
    const now = Date.UTC(2030, 0, 1);
    createDemo(now);
    const text = JSON.stringify(useFleetState.getState().mirrors);
    const times = [...text.matchAll(/"(?:at|\w+_at)":(\d+)/g)].map((m) =>
      Number(m[1]),
    );
    expect(times.length).toBeGreaterThan(0);
    for (const t of times) {
      expect(t).toBeLessThanOrEqual(now);
      expect(now - t).toBeLessThan(60 * 60_000);
    }
  });

  it('carries no personal names', () => {
    createDemo();
    const text = JSON.stringify([
      demoSession,
      demoOrganizations,
      useFleetState.getState().devices,
    ]);
    expect(text).not.toMatch(/jean|isahakyan/i);
  });

  it('signing out ends the session and tells listeners', async () => {
    const { auth } = createDemo();
    const seen: unknown[] = [];
    auth.onChange((s) => seen.push(s));
    await auth.signOut();
    expect(await auth.current()).toBeNull();
    expect(seen).toEqual([null]);
  });
});
