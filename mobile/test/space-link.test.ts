import { describe, expect, it } from 'vitest';
import { emptyMirror, type SpaceMirror } from '../src/fleet/mirror';
import type { SpaceView } from '../src/fleet/types';
import {
  LOOKING_MS,
  resolveSpaceLink,
  spaceLinkState,
} from '../src/shell/spaceLink';

const view = (space: string): SpaceView => ({
  space,
  hostDevice: 'mac-a',
  hostName: 'mac-A',
  originDevice: 'phone',
  projectName: 'theodore',
  name: 'fix-login',
  branch: 'ada/fix-login',
  status: 'idle',
  mode: 'edit',
  lastReply: null,
  question: null,
  startedHere: true,
  error: null,
});

const mirrorOf = (localId: string): SpaceMirror => ({
  ...emptyMirror(),
  space: { id: localId } as NonNullable<SpaceMirror['space']>,
});

describe('resolveSpaceLink', () => {
  const spaces = [view('rs_1'), view('rs_2')];
  const mirrors = { rs_2: mirrorOf('3f2a9c1b0d4e') };

  it('finds a space by its fleet id', () => {
    expect(resolveSpaceLink('rs_1', spaces, mirrors)).toEqual({
      kind: 'found',
      space: 'rs_1',
    });
  });

  it('finds a space by its id on its host, the one a PR footer carries', () => {
    expect(resolveSpaceLink('3f2a9c1b0d4e', spaces, mirrors)).toEqual({
      kind: 'found',
      space: 'rs_2',
    });
  });

  it('is unknown for a space not followed here, and for nothing', () => {
    expect(resolveSpaceLink('deadbeef', spaces, mirrors)).toEqual({
      kind: 'unknown',
    });
    expect(resolveSpaceLink('', spaces, mirrors)).toEqual({ kind: 'unknown' });
    expect(resolveSpaceLink('rs_1', [], {})).toEqual({ kind: 'unknown' });
  });
});

describe('spaceLinkState', () => {
  it('opens a found space, waits for the first connection, then calls it missing', () => {
    expect(spaceLinkState({ kind: 'found', space: 'rs_1' }, false, 0)).toBe(
      'open',
    );
    expect(spaceLinkState({ kind: 'unknown' }, false, 0)).toBe('looking');
    expect(spaceLinkState({ kind: 'unknown' }, true, 0)).toBe('missing');
    expect(spaceLinkState({ kind: 'unknown' }, false, LOOKING_MS)).toBe(
      'missing',
    );
  });
});
