/** "Load to end of file" shows only while there may be lines left past the
 *  last hunk: not for an added or deleted file, nor once the fetched file
 *  shows the last hunk reaches its end (#130). */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setTransport } from '../core/transport';
import type { DiffLine, FileDiff, Revision } from '../gen/contract';
import { loadShiki } from '../highlight';
import { RootStore } from '../stores/RootStore';
import { RootStoreProvider } from '../stores/context';
import { FakeTransport } from '../test/fakeTransport';
import { Harness, PR } from '../test/bigPr';

const PATH = 'src/tail.ts';
const HEAD = 'h'.repeat(40);

const text = (n: number) => `const v${n} = ${n};`;
/** Lines `1..n` of the head file, ending in a newline. */
const fileOf = (n: number) =>
  Array.from({ length: n }, (_, i) => text(i + 1)).join('\n') + '\n';

/** One hunk over new lines `start..start+n-1`, of `kind`. */
function revisionOf(
  status: FileDiff['status'],
  kind: DiffLine['kind'],
  start: number,
  n: number,
): Revision {
  const lines = Array.from({ length: n }, (_, i) => ({
    kind,
    text: text(start + i),
    old_no: kind === 'add' ? null : start + i,
    new_no: kind === 'del' ? null : start + i,
  }));
  const hunk = {
    id: 'h0',
    path: PATH,
    old_start: kind === 'add' ? 0 : start,
    old_lines: kind === 'add' ? 0 : n,
    new_start: kind === 'del' ? 0 : start,
    new_lines: kind === 'del' ? 0 : n,
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
        status,
        similarity: null,
        old_mode: null,
        new_mode: null,
        flags: [],
        additions: kind === 'add' ? n : 0,
        deletions: kind === 'del' ? n : 0,
        hunks: [hunk],
      },
    ],
  };
}

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

async function settleUntil(done: () => boolean) {
  for (let i = 0; i < 100 && !done(); i++) await settle();
}

describe('the load-to-end-of-file button', () => {
  let cleanup = () => {};

  beforeAll(async () => {
    await loadShiki();
  });

  afterEach(() => cleanup());

  async function mount(rev: Revision, file: string | null) {
    const transport = new FakeTransport();
    transport.onCall('get_file', () => file);
    setTransport(transport);
    const store = new RootStore();
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
    return { host, transport };
  }

  const loadButton = (host: HTMLElement) =>
    [...host.querySelectorAll<HTMLButtonElement>('.gap button')].find((b) =>
      b.textContent?.includes('Load to end of file'),
    ) ?? null;
  /** New-side line numbers of the rendered rows. */
  const newNos = (host: HTMLElement) =>
    [...host.querySelectorAll('.ln')]
      .map((el) => el.querySelectorAll('.no')[1]?.textContent)
      .filter((no) => no);

  it('is absent for an added file, which the hunk shows whole', async () => {
    const { host, transport } = await mount(
      revisionOf('added', 'add', 1, 5),
      fileOf(5),
    );
    expect(host.textContent).toContain(text(5));
    expect(loadButton(host)).toBeNull();
    expect(transport.calls.some((c) => c.cmd === 'get_file')).toBe(false);
  });

  it('is absent for a deleted file, which has no lines left', async () => {
    const { host } = await mount(revisionOf('deleted', 'del', 1, 5), null);
    // Folded by default: open it.
    const show = host.querySelector<HTMLButtonElement>('.show-file')!;
    await act(async () => show.click());
    expect(host.textContent).toContain(text(5));
    expect(loadButton(host)).toBeNull();
  });

  it('goes once the fetched file shows the last hunk reaches its end', async () => {
    const { host, transport } = await mount(
      revisionOf('modified', 'ctx', 31, 3),
      fileOf(33),
    );
    await settleUntil(() => loadButton(host) == null);
    expect(transport.calls.some((c) => c.cmd === 'get_file')).toBe(true);
    expect(loadButton(host)).toBeNull();
    expect(newNos(host)).not.toContain('34');
  });

  it('stays while lines are left, and loads exactly those', async () => {
    const { host } = await mount(
      revisionOf('modified', 'ctx', 31, 3),
      fileOf(40),
    );
    await settle();
    const load = loadButton(host)!;
    expect(load).not.toBeNull();
    await act(async () => load.click());
    await settleUntil(() => newNos(host).includes('40'));
    expect(newNos(host).slice(-7)).toEqual([
      '34',
      '35',
      '36',
      '37',
      '38',
      '39',
      '40',
    ]);
    // The newline that ends line 40 doesn't add a blank line 41.
    expect(newNos(host)).not.toContain('41');
  });

  it('adds no blank line past a hunk that already reached the end', async () => {
    // A hunk from line 1 fetches nothing up front, so the button shows.
    const { host } = await mount(
      revisionOf('modified', 'ctx', 1, 3),
      fileOf(3),
    );
    const load = loadButton(host)!;
    expect(load).not.toBeNull();
    await act(async () => load.click());
    await settleUntil(() => loadButton(host) == null);
    expect(loadButton(host)).toBeNull();
    expect(newNos(host)).toEqual(['1', '2', '3']);
  });
});
