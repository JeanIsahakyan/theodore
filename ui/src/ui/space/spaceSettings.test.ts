import { describe, expect, it } from 'vitest';
import {
  SPACE_SETTINGS,
  effectiveSpaceSetting,
  formatSpaceSetting,
  projectOverride,
  projectScope,
} from './spaceSettings';

const row = (key: string, value: unknown, scope = 'user') => ({
  key,
  scope,
  value,
});
const WEB = 'github:acme/web';

describe('space settings resolution', () => {
  it('lists the five overridable settings with their built-in defaults', () => {
    expect(SPACE_SETTINGS.map((s) => [s.key, s.default])).toEqual([
      ['spaces.auto_archive_days', 7],
      ['spaces.auto_archive_merged', true],
      ['spaces.max_children', 5],
      ['spaces.max_depth', 2],
      ['spaces.ask_timeout_secs', 180],
    ]);
    expect(projectScope(WEB)).toBe('project:github:acme/web');
  });

  it('resolves project → user → default', () => {
    const key = 'spaces.max_children';
    expect(effectiveSpaceSetting([], key, WEB)).toEqual({
      value: 5,
      source: 'default',
    });
    const user = [row(key, 3)];
    expect(effectiveSpaceSetting(user, key, WEB)).toEqual({
      value: 3,
      source: 'user',
    });
    const both = [...user, row(key, 8, projectScope(WEB))];
    expect(effectiveSpaceSetting(both, key, WEB)).toEqual({
      value: 8,
      source: 'project',
    });
    // Another project, or no project at all, sees the user's value.
    expect(effectiveSpaceSetting(both, key, 'github:acme/api')).toEqual({
      value: 3,
      source: 'user',
    });
    expect(effectiveSpaceSetting(both, key)).toEqual({
      value: 3,
      source: 'user',
    });
  });

  it('ignores a value of the wrong shape at any layer', () => {
    const key = 'spaces.auto_archive_days';
    const rows = [
      row(key, 'soon'),
      row(key, -1, projectScope(WEB)),
      row(key, null, projectScope('github:acme/api')),
    ];
    expect(effectiveSpaceSetting(rows, key, WEB)).toEqual({
      value: 7,
      source: 'default',
    });
    expect(projectOverride(rows, key, WEB)).toBeUndefined();
    expect(projectOverride(rows, key, 'github:acme/api')).toBeUndefined();
    expect(
      effectiveSpaceSetting(
        [row('spaces.auto_archive_merged', 'no')],
        'spaces.auto_archive_merged',
      ),
    ).toEqual({ value: true, source: 'default' });
  });

  it('a cleared override (null) falls back to the user value', () => {
    const key = 'spaces.ask_timeout_secs';
    const rows = [row(key, 60), row(key, null, projectScope(WEB))];
    expect(effectiveSpaceSetting(rows, key, WEB)).toEqual({
      value: 60,
      source: 'user',
    });
    expect(projectOverride([row(key, 30, projectScope(WEB))], key, WEB)).toBe(
      30,
    );
  });

  it('formats values with their unit', () => {
    expect(formatSpaceSetting('spaces.auto_archive_days', 7)).toBe('7 days');
    expect(formatSpaceSetting('spaces.ask_timeout_secs', 180)).toBe('180 s');
    expect(formatSpaceSetting('spaces.max_children', 5)).toBe('5');
    expect(formatSpaceSetting('spaces.auto_archive_merged', false)).toBe('Off');
  });
});
