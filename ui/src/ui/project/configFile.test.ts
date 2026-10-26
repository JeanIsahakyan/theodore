import { describe, expect, it, vi } from 'vitest';
import type {
  ConfigDraft,
  ConfigProblem,
  SaveConfigResult,
} from '../../gen/contract';
import {
  configPrToast,
  hasErrors,
  newlineEdit,
  offsetOfLine,
  previewLayer,
  problemText,
  saveOptions,
  savedText,
  startOf,
  tabEdit,
  textOf,
} from './configFile';

function draft(over: Partial<ConfigDraft> = {}): ConfigDraft {
  return {
    project: 'local:app',
    generated: '# generated\nreview:\n  agents:\n    chat: codex\n',
    files: [
      {
        layer: 'global',
        path: '/home/me/.theodore/config.yaml',
        save_to: '/home/me/.theodore/config.yaml',
        text: null,
      },
      {
        layer: 'repo',
        path: '/src/app/.theodore/config.yaml',
        save_to: '/src/app/.theodore/config.yaml',
        text: null,
      },
      {
        layer: 'local',
        path: '/src/app/.theodore/config.local.yaml',
        save_to: '/src/app/.theodore/config.local.yaml',
        text: null,
      },
    ],
    initial: null,
    can_commit: true,
    commit_note: null,
    ...over,
  };
}

const withText = (d: ConfigDraft, layer: string, text: string) => ({
  ...d,
  files: d.files.map((f) => (f.layer === layer ? { ...f, text } : f)),
});

describe('where the editor starts', () => {
  it('opens the existing file, else the text generated from settings', () => {
    expect(startOf(draft())).toEqual({
      source: 'generated',
      text: draft().generated,
    });
    const d = {
      ...withText(draft(), 'repo', 'review: {}\n'),
      initial: 'repo' as const,
    };
    expect(startOf(d)).toEqual({ source: 'repo', text: 'review: {}\n' });
    expect(textOf(d, 'local')).toBeNull();
    expect(textOf(d, 'generated')).toBe(d.generated);
  });

  it('previews generated text as the repo layer', () => {
    expect(previewLayer('generated')).toBe('repo');
    expect(previewLayer('local')).toBe('local');
  });
});

describe('Tab and Enter in the textarea', () => {
  it('Tab inserts two spaces at the cursor', () => {
    expect(tabEdit('ab', 1, 1, false)).toEqual({
      text: 'a  b',
      start: 3,
      end: 3,
    });
  });

  it('indents and dedents every selected line, the selection following', () => {
    const text = 'a:\nb: 1\nc: 2\n';
    const sel = { start: 3, end: 12 }; // "b: 1\nc: 2"
    const ind = tabEdit(text, sel.start, sel.end, false);
    expect(ind.text).toBe('a:\n  b: 1\n  c: 2\n');
    expect(ind.text.slice(ind.start, ind.end)).toBe('b: 1\n  c: 2');
    const back = tabEdit(ind.text, ind.start, ind.end, true);
    expect(back.text).toBe(text);
  });

  it('Shift+Tab on a line with one space removes it, never more than there is', () => {
    expect(tabEdit(' x', 1, 1, true).text).toBe('x');
    expect(tabEdit('x', 0, 0, true).text).toBe('x');
  });

  it('Enter keeps the indent, one deeper after a block key', () => {
    expect(newlineEdit('  hide: [x]', 11, 11)).toEqual({
      text: '  hide: [x]\n  ',
      start: 14,
      end: 14,
    });
    expect(newlineEdit('review:', 7, 7).text).toBe('review:\n  ');
    expect(newlineEdit('review:  # rules', 16, 16).text).toBe(
      'review:  # rules\n  ',
    );
    expect(newlineEdit('# a comment:', 12, 12).text).toBe('# a comment:\n');
  });
});

describe('problems', () => {
  const p = (over: Partial<ConfigProblem>): ConfigProblem => ({
    level: 'error',
    line: null,
    column: null,
    message: 'bad',
    ...over,
  });

  it('reads with its position', () => {
    expect(problemText(p({ line: 4, column: 9 }))).toBe(
      'Line 4, column 9: bad',
    );
    expect(problemText(p({ line: 4 }))).toBe('Line 4: bad');
    expect(problemText(p({}))).toBe('bad');
  });

  it('only errors block saving', () => {
    expect(hasErrors([p({ level: 'warning' })])).toBe(false);
    expect(hasErrors([p({ level: 'warning' }), p({})])).toBe(true);
  });

  it('finds where a line starts', () => {
    const text = 'a\nbb\nccc';
    expect(offsetOfLine(text, 1)).toBe(0);
    expect(offsetOfLine(text, 3)).toBe(5);
    expect(offsetOfLine(text, 9)).toBe(text.length);
  });
});

describe('the Save to… menu', () => {
  it('a clean local folder offers repo, repo and commit, local, global', () => {
    const opts = saveOptions(draft(), true);
    expect(opts.map((o) => o.id)).toEqual([
      'repo',
      'repo-commit',
      'local',
      'global',
    ]);
    expect(opts[1]).toMatchObject({ layer: 'repo', commit: true });
  });

  it('no commit when the folder is dirty, nor for a host project', () => {
    const dirty = draft({ can_commit: false, commit_note: '2 other changes' });
    expect(saveOptions(dirty, true).map((o) => o.id)).toEqual([
      'repo',
      'local',
      'global',
    ]);
    const host = draft({ can_commit: false });
    expect(saveOptions(host, false).some((o) => o.commit)).toBe(false);
  });

  it('says when a save replaces a file; a host repo save never does', () => {
    const d = withText(withText(draft(), 'global', 'x: 1'), 'repo', 'y: 1');
    const folder = saveOptions(d, true);
    expect(folder.find((o) => o.id === 'global')?.replaces).toBe(true);
    expect(folder.find((o) => o.id === 'repo')?.replaces).toBe(true);
    expect(folder.find((o) => o.id === 'local')?.replaces).toBe(false);
    const host = saveOptions(d, false);
    expect(host.find((o) => o.id === 'repo')?.replaces).toBe(false);
  });
});

describe('toasts', () => {
  const result = (over: Partial<SaveConfigResult>): SaveConfigResult => ({
    layer: 'repo',
    path: 'me/theodore-config',
    message: 'Pushed me/theodore-config; opening the PR…',
    branch: 'me/theodore-config',
    commit: 'abc',
    trusted: false,
    ...over,
  });

  it('a save says what happened, and when commands were allowed', () => {
    expect(savedText(result({}))).toBe(
      'Pushed me/theodore-config; opening the PR…',
    );
    expect(savedText(result({ message: 'Saved', trusted: true }))).toBe(
      'Saved. Its commands are allowed.',
    );
  });

  it('the config PR toast opens the link', () => {
    const open = vi.fn();
    const t = configPrToast(12, 'https://github.com/a/b/pull/12', open);
    expect(t.text).toBe('Config PR #12 is open');
    t.action?.onAction();
    expect(open).toHaveBeenCalledWith('https://github.com/a/b/pull/12');
    expect(configPrToast(12, '', open).action).toBeUndefined();
  });
});
