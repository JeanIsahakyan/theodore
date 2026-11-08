/** A break in the diff — the fold between hunks, or the edge of a partly
 *  loaded gap — can land inside a multi-line string. The code after the
 *  string's closing quote stays code in both, in the real diff (#133). */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { setTransport } from '../core/transport';
import type { Revision } from '../gen/contract';
import { loadShiki, WHOLE_FILE_MAX_CHARS } from '../highlight';
import { RootStore } from '../stores/RootStore';
import { RootStoreProvider } from '../stores/context';
import { FakeTransport } from '../test/fakeTransport';
import { Harness, PR } from '../test/bigPr';

const PATH = 'src/query.ts';
const HEAD = 'h'.repeat(40);
const KEYWORD = 'var(--shiki-token-keyword)';

/** Line 1 opens a string that line 13 closes; code down to the hunk at 31. */
const LINES = [
  'const sql = `',
  ...Array.from({ length: 11 }, (_, i) => `  select ${i}`),
  '`;',
  ...Array.from({ length: 22 }, (_, i) => `const v${i + 14} = ${i};`),
];

function revisionAt(start: number): Revision {
  const lines = LINES.slice(start - 1, start + 2).map((text, i) => ({
    kind: 'ctx' as const,
    text,
    old_no: start + i,
    new_no: start + i,
  }));
  const hunk = {
    id: 'h0',
    path: PATH,
    old_start: start,
    old_lines: 3,
    new_start: start,
    new_lines: 3,
    header: '',
    lines,
  };
  return {
    base: 'b'.repeat(40),
    head: HEAD,
    files: [
      {
        path: PATH,
        old_path: null,
        status: 'modified',
        similarity: null,
        old_mode: null,
        new_mode: null,
        flags: [],
        additions: 0,
        deletions: 0,
        hunks: [hunk],
      },
    ],
  };
}

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

/** `tokenizeFile` yields between slices; waits for it to land. */
async function settleUntil(done: () => boolean) {
  for (let i = 0; i < 100 && !done(); i++) await settle();
}

describe('a diff break inside a multi-line string', () => {
  let cleanup = () => {};

  beforeAll(async () => {
    await loadShiki();
  });

  afterEach(() => cleanup());

  async function mount(rev: Revision, file = LINES.join('\n')) {
    const transport = new FakeTransport();
    transport.onCall('get_file', () => file);
    setTransport(transport);
    const store = new RootStore();
    const tokenized = vi.spyOn(store.fileTokens, 'get');
    store.sync.pool.put('pr', PR, {
      pr: { repo: { host: 'github', owner: 'acme', name: 'app' }, number: 1 },
      url: 'https://example.test/acme/app/pull/1',
      head_sha: HEAD,
    });
    store.sync.pool.put('pr_detail', PR, {
      threads: [],
      checks: [],
      commits: [],
    });
    store.sync.pool.put('grouping', PR, {
      rev: HEAD,
      groups: [
        {
          id: 'g1',
          title: 'Everything',
          why: 'all of it',
          kind: 'normal',
          risk: null,
          check: [],
          hunks: ['h0'],
          outliers: [],
        },
      ],
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(
        <RootStoreProvider store={store}>
          <Harness rev={rev} onReady={() => {}} />
        </RootStoreProvider>,
      ),
    );
    await settle();
    cleanup = () => {
      act(() => root.unmount());
      host.remove();
    };
    return { host, transport, tokenized };
  }

  /** The colour of the `const` on the row for new-side line `no`. */
  const constColor = (host: HTMLElement, no: number) => {
    const row = [...host.querySelectorAll('.ln')].find(
      (el) => el.querySelectorAll('.no')[1]?.textContent === String(no),
    );
    const word = [...(row?.querySelectorAll('code span') ?? [])].find(
      (el) => el.textContent === 'const',
    );
    return (word as HTMLElement | undefined)?.style.color;
  };

  it('colours the code in a hunk that starts on the closing quote', async () => {
    const { host } = await mount(revisionAt(13));
    await settleUntil(() => constColor(host, 14) === KEYWORD);
    expect(constColor(host, 14)).toBe(KEYWORD);
  });

  it('colours the code in a gap only partly loaded, from inside the string', async () => {
    const { host } = await mount(revisionAt(31));
    // The first bite reveals lines 11-30: its first line is in the string.
    const load = host.querySelector<HTMLButtonElement>('.gap button')!;
    await act(async () => load.click());
    await settleUntil(() => constColor(host, 14) === KEYWORD);
    expect(constColor(host, 14)).toBe(KEYWORD);
  });

  it('fetches nothing for a hunk at the top of the file', async () => {
    const { transport } = await mount(revisionAt(1));
    expect(transport.calls.some((c) => c.cmd === 'get_file')).toBe(false);
  });

  it('keeps a file over the size limit out of the token cache', async () => {
    // Long enough that its text, as a cache key, would be a copy of it.
    const big = `${LINES.join('\n')}\n${'// pad\n'.repeat(WHOLE_FILE_MAX_CHARS / 7)}`;
    const { host, transport, tokenized } = await mount(revisionAt(13), big);
    await settleUntil(() => transport.calls.some((c) => c.cmd === 'get_file'));
    await settle();
    expect(transport.calls.some((c) => c.cmd === 'get_file')).toBe(true);
    expect(tokenized).not.toHaveBeenCalled();
    // The hunk still shows, tokenized from its own lines.
    expect(host.textContent).toContain('const v14 = 0;');
  });
});
