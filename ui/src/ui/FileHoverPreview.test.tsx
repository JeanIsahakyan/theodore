/** Hovering a file in a chat: nothing happens until someone hovers, then the
 *  right thing for each kind of file, from the cache the second time. */
import { act, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type Mounted } from '../test/dom';
import type { ChatMessage as Message, TurnStep } from '../gen/contract';
import { setTransport } from '../core/transport';
import { RootStore } from '../stores/RootStore';
import { RootStoreProvider } from '../stores/context';
import { FakeTransport } from '../test/fakeTransport';
import { ChatMessage } from './ChatTurn';
import {
  clearFilePreviewCache,
  FilePreviewScope,
  useFileHover,
} from './FileHoverPreview';
import { TimelineRows, TurnFiles } from './TurnTimeline';

// jsdom has no `CSS`; the popover reads it to find its keyboard layout meta.
globalThis.CSS ??= { escape: (s: string) => s } as unknown as typeof CSS;

let m: Mounted | null = null;
let transport: FakeTransport;

beforeEach(() => {
  vi.useFakeTimers();
  transport = new FakeTransport();
  setTransport(transport);
  clearFilePreviewCache();
});

afterEach(() => {
  m?.unmount();
  m = null;
  vi.useRealTimers();
});

async function render(node: ReactNode) {
  m?.unmount();
  m = await mount(
    <RootStoreProvider store={new RootStore()}>
      <FilePreviewScope space="s1" reply="r1">
        {node}
      </FilePreviewScope>
    </RootStoreProvider>,
  );
}

/** The chip's hover: React reads the bubbling `mouseover` as `mouseEnter`. */
const hover = (el: Element) =>
  act(async () => {
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  });
const unhover = (el: Element) =>
  act(async () => {
    el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
  });
const elapse = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

const card = () => document.querySelector('.file-hover-card');
const calls = () => transport.calls.filter((c) => c.cmd === 'file_preview');

const diff = (path: string, text: string, more_lines = 0) => ({
  pinned: true,
  preview: {
    kind: 'diff',
    more_lines,
    file: {
      path,
      old_path: null,
      status: 'modified',
      similarity: null,
      old_mode: null,
      new_mode: null,
      flags: [],
      additions: 1,
      deletions: 0,
      hunks: [
        {
          id: `h-${path}`,
          path,
          old_start: 1,
          old_lines: 1,
          new_start: 1,
          new_lines: 1,
          header: '',
          lines: [{ kind: 'add', text, old_no: null, new_no: 1 }],
        },
      ],
    },
  },
});

const text = (t: string, extra: object = {}) => ({
  pinned: true,
  preview: {
    kind: 'text',
    text: t,
    bytes: t.length,
    more_lines: 0,
    cut: false,
    ...extra,
  },
});

const chips = () => m!.host.querySelectorAll('.turn-file');

const files = [
  { path: 'src/a.rs', additions: 1, deletions: 0 },
  { path: 'src/b.rs', additions: 2, deletions: 1 },
];

describe('hover', () => {
  it('asks nothing for a chip nobody hovers, and waits 300 ms for one', async () => {
    await render(<TurnFiles files={files} />);
    expect(calls()).toHaveLength(0);

    await hover(chips()[0]!);
    await elapse(299);
    expect(card()).toBeNull();
    expect(calls()).toHaveLength(0);

    transport.onCall('file_preview', () => diff('src/a.rs', 'let a = 1;'));
    await elapse(1);
    expect(card()?.textContent).toContain('let a = 1;');
    expect(calls()).toHaveLength(1);
    expect(calls()[0]!.args).toEqual({
      req: {
        source: { kind: 'space', space: 's1', reply: 'r1' },
        path: 'src/a.rs',
      },
    });
  });

  it('leaving before the delay opens nothing', async () => {
    await render(<TurnFiles files={files} />);
    await hover(chips()[0]!);
    await elapse(100);
    await unhover(chips()[0]!);
    await elapse(1000);
    expect(card()).toBeNull();
    expect(calls()).toHaveLength(0);
  });

  it('closes after the pointer leaves, unless it went into the popover', async () => {
    transport.onCall('file_preview', () => diff('src/a.rs', 'x'));
    await render(<TurnFiles files={files} />);
    await hover(chips()[0]!);
    await elapse(300);

    await unhover(chips()[0]!);
    await hover(card()!.firstElementChild!);
    await elapse(1000);
    expect(card()).not.toBeNull();

    await unhover(card()!.firstElementChild!);
    await elapse(120);
    expect(card()).toBeNull();
  });

  it('moving to another chip swaps at once, with nothing in between', async () => {
    transport.onCall('file_preview', (args) => {
      const path = (args as { req: { path: string } }).req.path;
      return diff(path, `body of ${path}`);
    });
    await render(<TurnFiles files={files} />);
    await hover(chips()[0]!);
    await elapse(300);
    expect(card()?.textContent).toContain('body of src/a.rs');

    await unhover(chips()[0]!);
    await hover(chips()[1]!);
    await elapse(60);
    expect(document.querySelectorAll('.file-hover-card')).toHaveLength(1);
    expect(card()?.textContent).toContain('body of src/b.rs');
  });

  it('a click opens its file and no popover', async () => {
    const opened: (string | null)[] = [];
    await render(<TurnFiles files={files} onOpen={(p) => opened.push(p)} />);
    const chip = chips()[0]! as HTMLElement;
    await hover(chip);
    await act(async () => {
      chip.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      chip.focus();
      chip.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      chip.click();
    });
    await elapse(1000);
    expect(opened).toEqual(['src/a.rs']);
    expect(card()).toBeNull();
    expect(calls()).toHaveLength(0);
  });
});

describe('keyboard', () => {
  it('focus opens it, Escape closes it', async () => {
    transport.onCall('file_preview', () => diff('src/a.rs', 'x'));
    await render(<TurnFiles files={files} />);
    await act(async () => (chips()[0] as HTMLElement).focus());
    await elapse(300);
    expect(card()).not.toBeNull();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(card()).toBeNull();
  });

  it('a tool row file chip is reachable by Tab, others stay plain', async () => {
    const steps: TurnStep[] = [
      { kind: 'tool', name: 'Read', target: 'src/x.rs', ok: true },
      { kind: 'tool', name: 'Bash', target: 'ls', ok: true },
    ];
    await render(<TimelineRows steps={steps} keepText />);
    const [file, command] = [...m!.host.querySelectorAll('.turn-chip')];
    expect(file!.getAttribute('tabindex')).toBe('0');
    expect(command!.hasAttribute('tabindex')).toBe(false);
  });
});

describe('fetching', () => {
  it('asks once per file and revision', async () => {
    transport.onCall('file_preview', () => diff('src/a.rs', 'x'));
    await render(<TurnFiles files={files} />);
    for (let i = 0; i < 2; i += 1) {
      await hover(chips()[0]!);
      await elapse(300);
      expect(card()).not.toBeNull();
      await unhover(chips()[0]!);
      await elapse(120);
    }
    expect(calls()).toHaveLength(1);

    // The same path in another turn is another answer.
    m?.unmount();
    m = await mount(
      <RootStoreProvider store={new RootStore()}>
        <FilePreviewScope space="s1" reply="r2">
          <TurnFiles files={files} />
        </FilePreviewScope>
      </RootStoreProvider>,
    );
    await hover(chips()[0]!);
    await elapse(300);
    expect(calls()).toHaveLength(2);
  });

  it('keeps a running turn only briefly', async () => {
    transport.onCall('file_preview', () => ({
      ...diff('src/a.rs', 'x'),
      pinned: false,
    }));
    m = await mount(
      <RootStoreProvider store={new RootStore()}>
        <FilePreviewScope space="s1" reply={null}>
          <TurnFiles files={files} />
        </FilePreviewScope>
      </RootStoreProvider>,
    );
    await hover(chips()[0]!);
    await elapse(300);
    expect(card()?.textContent).toContain('Current');
    await unhover(chips()[0]!);
    await elapse(120);

    await hover(chips()[0]!);
    await elapse(300);
    expect(calls()).toHaveLength(1);
    await unhover(chips()[0]!);
    await elapse(5000);

    await hover(chips()[0]!);
    await elapse(300);
    expect(calls()).toHaveLength(2);
  });

  it('a slow answer for one file never shows on another', async () => {
    let releaseA!: (v: unknown) => void;
    transport.onCall('file_preview', (args) => {
      const path = (args as { req: { path: string } }).req.path;
      if (path === 'src/a.rs') return new Promise((r) => (releaseA = r));
      return diff(path, 'body of b');
    });
    await render(<TurnFiles files={files} />);
    await hover(chips()[0]!);
    await elapse(300);

    await unhover(chips()[0]!);
    await hover(chips()[1]!);
    await elapse(60);
    expect(card()?.textContent).toContain('body of b');

    await act(async () => releaseA(diff('src/a.rs', 'stale a')));
    await elapse(0);
    expect(card()?.textContent).toContain('body of b');
    expect(card()?.textContent).not.toContain('stale a');
  });

  it('a failed fetch is quiet, and tried again next time', async () => {
    transport.onCall('file_preview', () => {
      throw new Error('git failed');
    });
    await render(<TurnFiles files={files} />);
    await hover(chips()[0]!);
    await elapse(300);
    expect(card()?.querySelector('.file-hover-gap')?.textContent).toContain(
      'No preview',
    );
    await unhover(chips()[0]!);
    await elapse(120);

    transport.onCall('file_preview', () => diff('src/a.rs', 'now it works'));
    await hover(chips()[0]!);
    await elapse(300);
    expect(card()?.textContent).toContain('now it works');
  });
});

describe('each kind of file', () => {
  async function previewOf(path: string, answer: unknown) {
    transport.onCall('file_preview', () => answer);
    await render(<TurnFiles files={[{ path, additions: 0, deletions: 0 }]} />);
    await hover(chips()[0]!);
    await elapse(300);
    return card()!;
  }

  it('a diff, with its capped lines counted', async () => {
    const c = await previewOf('a.rs', diff('a.rs', 'fn a() {}', 12));
    expect(c.querySelector('.file-hover-diff .ln.t-add')).not.toBeNull();
    expect(c.querySelector('.file-hover-more')?.textContent).toBe(
      '12 more lines',
    );
  });

  it('a read-only code file: its lines, numbered', async () => {
    const c = await previewOf('a.rs', text('one\ntwo'));
    const lines = c.querySelectorAll('.file-hover-text .ln');
    expect(lines).toHaveLength(2);
    expect(lines[1]!.querySelector('.no')?.textContent).toBe('2');
  });

  it('a read-only Markdown file is rendered', async () => {
    const c = await previewOf('README.md', text('# Title'));
    expect(c.querySelector('.file-hover-md h1')?.textContent).toBe('Title');
  });

  it('a file read in part says it goes on', async () => {
    const c = await previewOf('a.log', text('one', { cut: true, bytes: 2048 }));
    expect(c.querySelector('.file-hover-cut')?.textContent).toContain('2.0 KB');
  });

  it('an image is an <img> from data: only, SVG included', async () => {
    const c = await previewOf('logo.svg', {
      pinned: true,
      preview: {
        kind: 'image',
        mime: 'image/svg+xml',
        base64: 'PHN2Zy8+',
        bytes: 6,
      },
    });
    expect(c.querySelector('img')?.getAttribute('src')).toBe(
      'data:image/svg+xml;base64,PHN2Zy8+',
    );
    // Never inlined: the only <svg> in it is the header's file icon.
    expect(c.querySelector('svg:not([data-file-type])')).toBeNull();
  });

  it('binary, too large and missing: the name and a short note', async () => {
    const binary = await previewOf('a.bin', {
      pinned: true,
      preview: { kind: 'unavailable', reason: 'binary', bytes: 2048 },
    });
    expect(binary.querySelector('.file-hover-gap')?.textContent).toBe(
      'a.binBinary file · 2.0 KB',
    );
    clearFilePreviewCache();
    const big = await previewOf('b.png', {
      pinned: true,
      preview: { kind: 'unavailable', reason: 'too_large', bytes: 9 * 1048576 },
    });
    expect(big.querySelector('.file-hover-gap')?.textContent).toContain(
      'Too large to preview',
    );
    clearFilePreviewCache();
    const gone = await previewOf('gone.rs', {
      pinned: true,
      preview: { kind: 'unavailable', reason: 'missing', bytes: null },
    });
    expect(gone.querySelector('.file-hover-gap')?.textContent).toBe(
      'gone.rsNo preview',
    );
  });
});

describe('in the AI panel', () => {
  function RefChip({ revision }: { revision: string }) {
    const hover = useFileHover<HTMLSpanElement>('a.rs', () => ({
      source: { kind: 'pr', pr: 'p1' },
      revision,
    }));
    return (
      <>
        <span {...hover.triggerProps} className="ref-chip" />
        {hover.popover}
      </>
    );
  }

  it('previews the PR, once per head', async () => {
    transport.onCall('file_preview', () => diff('a.rs', 'x'));
    m = await mount(<RefChip revision="head1" />);
    const chip = () => m!.host.querySelector('.ref-chip')!;
    await hover(chip());
    await elapse(300);
    expect(card()).not.toBeNull();
    expect(calls()[0]!.args).toEqual({
      req: { source: { kind: 'pr', pr: 'p1' }, path: 'a.rs' },
    });
    await unhover(chip());
    await elapse(120);

    m?.unmount();
    m = await mount(<RefChip revision="head2" />);
    await hover(chip());
    await elapse(300);
    expect(calls()).toHaveLength(2);
  });
});

describe('in the chat', () => {
  const reply: Message = {
    id: 'r1',
    pr: 'space:s1',
    author: { kind: 'agent', agent: 'claude' },
    text: 'done',
    at: 1000,
    changed_files: [{ path: 'src/a.rs', additions: 1, deletions: 0 }],
    duration_ms: 1000,
    refs: [],
  } as unknown as Message;

  it('a turn chip keeps opening the Changes pane, and previews on hover', async () => {
    const opened: (string | null)[] = [];
    transport.onCall('file_preview', () => diff('src/a.rs', 'x'));
    await render(<ChatMessage m={reply} onOpenFile={(p) => opened.push(p)} />);
    await hover(m!.host.querySelector('.turn-file')!);
    await elapse(300);
    expect(card()).not.toBeNull();
    await act(async () =>
      (m!.host.querySelector('.turn-file') as HTMLElement).click(),
    );
    expect(opened).toEqual(['src/a.rs']);
  });

  it('opening one changes nothing in the row, and a chat without a scope has no preview', async () => {
    transport.onCall('file_preview', () => diff('src/a.rs', 'x'));
    await render(<TurnFiles files={files} />);
    const before = m!.host.innerHTML;
    await hover(chips()[0]!);
    await elapse(300);
    expect(m!.host.innerHTML).toBe(before);

    m?.unmount();
    m = await mount(
      <RootStoreProvider store={new RootStore()}>
        <TurnFiles files={files} />
      </RootStoreProvider>,
    );
    expect(chips()[0]!.getAttribute('title')).toBe('src/a.rs');
    await hover(chips()[0]!);
    await elapse(300);
    expect(card()).toBeNull();
  });
});
