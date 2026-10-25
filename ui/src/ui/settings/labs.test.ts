import { describe, expect, it } from 'vitest';
import {
  BITBUCKET_LAB,
  GITLAB_LAB,
  LABS,
  LINEAR_LAB,
  hostOn,
  labOn,
  linearOn,
} from './labs';

const user = (key: string, value: unknown) => ({ key, scope: 'user', value });

describe('labOn', () => {
  it('is off with no setting', () => {
    expect(labOn([], LINEAR_LAB)).toBe(false);
  });
  it('is on only for an explicit true in the user scope', () => {
    expect(labOn([user(LINEAR_LAB, true)], LINEAR_LAB)).toBe(true);
    expect(labOn([user(LINEAR_LAB, false)], LINEAR_LAB)).toBe(false);
    expect(labOn([user(LINEAR_LAB, 'true')], LINEAR_LAB)).toBe(false);
    expect(
      labOn([{ key: LINEAR_LAB, scope: 'repo:o/r', value: true }], LINEAR_LAB),
    ).toBe(false);
  });
  it("doesn't read another lab's switch", () => {
    expect(labOn([user(GITLAB_LAB, true)], BITBUCKET_LAB)).toBe(false);
  });
});

describe('hostOn', () => {
  it('always has GitHub and local folders', () => {
    expect(hostOn([], 'github')).toBe(true);
    expect(hostOn([], 'local')).toBe(true);
  });
  it('has GitLab and Bitbucket only once their lab is on', () => {
    expect(hostOn([], 'gitlab')).toBe(false);
    expect(hostOn([], 'bitbucket')).toBe(false);
    const s = [user(GITLAB_LAB, true)];
    expect(hostOn(s, 'gitlab')).toBe(true);
    expect(hostOn(s, 'bitbucket')).toBe(false);
    expect(hostOn([user(BITBUCKET_LAB, true)], 'bitbucket')).toBe(true);
  });
});

describe('linearOn', () => {
  it('needs both the build flag and the lab', () => {
    expect(linearOn(true, [])).toBe(false);
    expect(linearOn(false, [user(LINEAR_LAB, true)])).toBe(false);
    expect(linearOn(true, [user(LINEAR_LAB, true)])).toBe(true);
  });
});

describe('LABS', () => {
  it('lists Linear, GitLab and Bitbucket, each under its own key', () => {
    expect(LABS.map((l) => l.key)).toEqual([
      LINEAR_LAB,
      GITLAB_LAB,
      BITBUCKET_LAB,
    ]);
  });
});
