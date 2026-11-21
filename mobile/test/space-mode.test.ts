import { beforeEach, describe, expect, it } from 'vitest';
import { mockDevices, mockSpaces, resetFleetState } from '../src/dev/mock';
import { memoryStorage } from '../src/keys/storage-types';
import {
  resetCompose,
  restorePicks,
  setSpaceMode,
  spaceModeNow,
  useCompose,
} from '../src/state/compose';
import { lastPicksStore } from '../src/state/lastPicks';
import { useFleetState } from '../src/state/fleet';

// The mode of a space's next message (the model sheet's Mode step, Revise):
// kept per space in the compose store, since the iOS sheet is its own route.
describe("a space's mode for its next message", () => {
  beforeEach(() => {
    resetCompose();
    resetFleetState();
    useFleetState.setState({ devices: mockDevices, spaces: mockSpaces });
  });

  it('nothing picked: the space’s own', () => {
    expect(spaceModeNow(undefined, 'edit')).toBe('edit');
    expect(spaceModeNow(undefined, 'run')).toBe('run');
  });

  it('picked: kept for that space, with the mode it was picked under', () => {
    setSpaceMode('sp-idle', 'plan');
    const c = useCompose.getState();
    expect(c.spaceModes).toEqual({ 'sp-idle': { mode: 'plan', of: 'edit' } });
    expect(spaceModeNow(c.spaceModes['sp-idle'], 'edit')).toBe('plan');
    // Another space is untouched.
    expect(spaceModeNow(c.spaceModes['sp-running'], 'run')).toBe('run');
  });

  it('sticky: a turn run in another mode starts the next one there', () => {
    setSpaceMode('sp-idle', 'plan');
    const pick = useCompose.getState().spaceModes['sp-idle'];
    // The plan was approved and built: the space is in Edit again (picked
    // under Edit, so Plan still shows) …
    expect(spaceModeNow(pick, 'edit')).toBe('plan');
    // … until the host reports a turn in Run: the next message starts there.
    expect(spaceModeNow(pick, 'run')).toBe('run');
  });

  it('a space not listed is picked under Edit', () => {
    setSpaceMode('sp-gone', 'ask');
    expect(useCompose.getState().spaceModes['sp-gone']).toEqual({
      mode: 'ask',
      of: 'edit',
    });
  });

  it('cleared with the account or organization, not written anywhere', async () => {
    const store = lastPicksStore(memoryStorage());
    await restorePicks(store, 'user_1.org_1');
    setSpaceMode('sp-idle', 'run');
    expect(useCompose.getState().spaceModes['sp-idle']?.mode).toBe('run');
    await restorePicks(store, 'user_1.org_2');
    expect(useCompose.getState().spaceModes).toEqual({});
    expect(await store.load('user_1.org_1')).toBeNull();
  });
});
