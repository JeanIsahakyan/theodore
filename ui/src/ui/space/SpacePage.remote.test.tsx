/** A space that runs on another device (docs/fleet.md "One space UI:
 *  mirrored rows") opens on the same page: its chat, composer, Stop and
 *  plan, one quiet "Runs on <host>" instead of what only the host's
 *  worktree has, and never a command that would only fail here. */
import { act } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ChatMessage, Space, SpaceRemote } from '../../gen/contract';
import { setTransport } from '../../core/transport';
import { RootStore } from '../../stores/RootStore';
import { RootStoreProvider } from '../../stores/context';
import { FakeTransport } from '../../test/fakeTransport';
import { click, mount, settle, typeInto, type Mounted } from '../../test/dom';
import { device, remoteSpace, status, thisDevice } from '../../test/fleet';
import { installChatLayout, uninstallChatLayout } from '../../test/chatLayout';
import { messageView } from './messageView';
import { SpacePage } from './SpacePage';
import { spaceChatKey } from './spaces';

Element.prototype.scrollIntoView ??= function () {};
// jsdom has no `CSS.escape`; an open react-aria menu calls it.
(globalThis as { CSS?: { escape?: (s: string) => string } }).CSS ??= {};
globalThis.CSS.escape ??= (s: string) =>
  s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);

const REMOTE: SpaceRemote = {
  space: 'rs_1',
  host_device: 'd2',
  host_name: 'Studio Mac',
  project_name: 'app',
  started_here: true,
};

const space = (over: Partial<Space> = {}): Space => ({
  id: 'rs_1',
  // The host's project id; this device has one with the same id.
  project: 'local:app',
  name: 'fix-login',
  goal: 'Fix the login',
  branch: 'theo/fix-login',
  base: 'main',
  base_sha: 'b',
  head_sha: 'h',
  worktree: '',
  status: 'idle',
  agent: 'claude',
  model: null,
  mode: 'edit',
  review_pr: null,
  pr: null,
  turns: 1,
  run: null,
  error: null,
  created_at: 0,
  updated_at: 0,
  remote: REMOTE,
  turn_log: [
    {
      message: 'u1',
      reply: 'a1',
      from_sha: 'b',
      to_sha: 'h',
      at: 2,
    } as never,
  ],
  ...over,
});

const message = (id: string, over: Partial<ChatMessage>): ChatMessage => ({
  id,
  pr: spaceChatKey('rs_1'),
  author: { kind: 'me' },
  text: '',
  refs: [],
  at: 1,
  failed: null,
  ...over,
});

/** Commands that act on this device's worktree: none may be called. */
const LOCAL_ONLY = [
  'space_review',
  'space_config',
  'space_logs',
  'space_skills',
  'set_space_settings',
  'set_space_pinned',
  'undo_space_turn',
  'ship_space',
];

beforeAll(installChatLayout);
afterAll(uninstallChatLayout);

let m: Mounted | null = null;
let transport: FakeTransport;
let store: RootStore;

afterEach(() => {
  m?.unmount();
  m = null;
  document.body.innerHTML = '';
});

async function render(s: Space | null, maxMode: Space['mode'] = 'edit') {
  localStorage.clear();
  transport = new FakeTransport();
  transport.onCall('detect_agents', () => []);
  transport.onCall('space_send', () => 'u2');
  transport.onCall('space_stop', () => null);
  setTransport(transport);
  store = new RootStore();
  // Opening the chat's rows is the sync's own business here.
  store.sync.openPr = async () => {};
  store.fleet.setStatus(
    status({
      devices: [thisDevice(), device({ trusted: true, max_mode: maxMode })],
    }),
  );
  store.sync.pool.put('project', 'local:app', {
    id: 'local:app',
    repo: { host: 'local', owner: '', name: 'app' },
    path: '/src/app',
    default_branch: 'main',
    status: 'ready',
    error: null,
  });
  if (s) {
    store.sync.pool.put('space', s.id, s);
    store.sync.pool.put('chat_message', 'u1', message('u1', { text: 'go' }));
    store.sync.pool.put(
      'chat_message',
      'a1',
      message('a1', {
        author: { kind: 'agent', agent: 'claude' },
        text: 'Done.',
        at: 2,
      }),
    );
  }
  m = await mount(
    <RootStoreProvider store={store}>
      <SpacePage id="rs_1" />
    </RootStoreProvider>,
  );
  await settle();
  await settle();
}

const q = (sel: string) => m!.host.querySelector<HTMLElement>(sel);
const button = (label: string) =>
  m!.host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const calls = (cmd: string) =>
  transport.calls.filter((c) => c.cmd === cmd).map((c) => c.args);
const localCalls = () =>
  transport.calls.filter((c) => LOCAL_ONLY.includes(c.cmd)).map((c) => c.cmd);

describe('a remote space on the space page', () => {
  it('says where it runs instead of the local controls', async () => {
    await render(space());
    expect(q('.space-runs-on')?.textContent).toBe('Runs on Studio Mac');
    for (const label of [
      'Changes',
      'Terminal',
      'Logs',
      'More ways to ship',
      'Mirror into the folder',
      'Open the PR',
    ]) {
      expect(button(label)).toBeNull();
    }
    expect(q('.space-ship')).toBeNull();
    expect(q('.space-push')).toBeNull();
    // Archive forgets the copy here.
    expect(button('Archive space')).not.toBeNull();
    expect(m!.host.textContent).toContain('Done.');
    expect(localCalls()).toEqual([]);
  });

  it('sends text and mode only, through the same command', async () => {
    await render(space());
    // No agent chip: the host runs its own.
    expect(button('Agent')).toBeNull();
    const box = q('.chat-input textarea')!;
    await typeInto(box, 'and the signup');
    await act(async () => button('Send')!.click());
    await settle();
    expect(calls('space_send')).toEqual([
      {
        req: {
          space: 'rs_1',
          text: 'and the signup',
          agent: null,
          model: null,
          effort: null,
          mode: null,
          attachments: null,
        },
      },
    ]);
    expect(localCalls()).toEqual([]);
  });

  it('offers no mode above what the host allows', async () => {
    await render(space({ mode: 'plan' }), 'plan');
    await click(button('Mode'));
    await settle();
    const items = [
      ...document.querySelectorAll<HTMLElement>('[role^="menuitem"]'),
    ].map((e) => e.textContent?.match(/^(Ask|Plan|Edit|Run)/)?.[1]);
    expect(items).toEqual(['Ask', 'Plan']);
  });

  it('while a turn runs: Stop, and nothing queued behind it', async () => {
    await render(space({ status: 'running', run: 'space:rs_1:u2' }));
    const box = q('.chat-input textarea') as HTMLTextAreaElement;
    expect(box.placeholder).toContain('Running on Studio Mac');
    expect(button('Send now')).toBeNull();
    await act(async () => button('Stop')!.click());
    await settle();
    expect(calls('space_stop')).toEqual([{ space: 'rs_1' }]);
  });

  it('has no Undo or Back to here: its checkpoints are the host’s', () => {
    const s = space();
    const reply = { id: 'a1', author: { kind: 'agent', agent: 'claude' } };
    const v = messageView(s, reply as never);
    expect(v.undoHere).toBe(false);
    expect(v.back).toBe(false);
  });

  it('waits for the row of a space just started elsewhere', async () => {
    await render(null);
    expect(m!.host.textContent).toContain('This space no longer exists.');
    m!.unmount();
    m = null;
    await render(null);
    act(() => store.fleet.upsertSpace(remoteSpace({ status: 'starting' })));
    await settle();
    expect(m!.host.textContent).toContain('Starting on Studio Mac');
    act(() =>
      store.fleet.upsertSpace(
        remoteSpace({ status: 'failed', error: 'no such project' }),
      ),
    );
    await settle();
    expect(q('[role="alert"]')?.textContent).toBe('no such project');
  });
});
