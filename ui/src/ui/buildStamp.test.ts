import { describe, expect, it } from 'vitest';
import { buildLabel, buildReport, builtAtIso, shortCommit } from './buildStamp';

const sha = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const stamp = {
  version: '0.0.1',
  commit: sha,
  build_env: 'staging',
  built_at: Date.UTC(2026, 9, 24, 12, 30),
};

describe('build stamp', () => {
  it('shortens the sha and keeps the dirty mark', () => {
    expect(shortCommit(sha)).toBe('a1b2c3d');
    expect(shortCommit(`${sha}-dirty`)).toBe('a1b2c3d-dirty');
    expect(shortCommit('unknown')).toBe('unknown');
  });

  it('labels version · commit · env', () => {
    expect(buildLabel(stamp)).toBe('0.0.1 · a1b2c3d · staging');
  });

  it('reports the full sha and the build date', () => {
    expect(buildReport(stamp)).toBe(
      `Theodore 0.0.1 · a1b2c3d · staging\ncommit ${sha}\nbuilt 2026-10-24T12:30:00.000Z`,
    );
  });

  it('leaves the date out when the stamp has none', () => {
    expect(builtAtIso({ ...stamp, built_at: 0 })).toBeNull();
    expect(buildReport({ ...stamp, built_at: 0 })).not.toContain('built');
  });
});
