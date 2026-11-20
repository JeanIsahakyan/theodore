/** Settings → Agents → Accounts: each agent's accounts with sign-in and
 *  limit, the sign-in command of an extra one, add / check / remove through
 *  the core, the preferred account, auto-continue and fallback agents. */
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { click, mount, settle, typeInto, type Mounted } from '../../test/dom';
import type { AgentAccountStatus, AgentId } from '../../gen/contract';
import { setTransport } from '../../core/transport';
import { RootStore } from '../../stores/RootStore';
import { RootStoreProvider } from '../../stores/context';
import { FakeTransport } from '../../test/fakeTransport';
import {
  AgentAccounts,
  fallbackAgents,
  isAutoContinue,
  nextFallbacks,
  preferredAccount,
} from './AgentAccounts';

const status = (
  agent: AgentId,
  id: string,
  over: Partial<AgentAccountStatus> = {},
): AgentAccountStatus => ({
  account: {
    id,
    agent,
    label: id === 'default' ? 'Default' : id,
    config_dir: id === 'default' ? `~/.${agent}` : `/data/accounts/${id}`,
    default: id === 'default',
  },
  signed_in: null,
  sign_in_command: null,
  limit: null,
  preferred: id === 'default',
  ...over,
});

const WORK_CMD = 'CLAUDE_CONFIG_DIR=/data/accounts/work claude';

let m: Mounted | null = null;
let transport: FakeTransport;
let store: RootStore;

afterEach(() => {
  m?.unmount();
  m = null;
});

async function render(rows: AgentAccountStatus[]) {
  transport = new FakeTransport();
  transport.onCall('agent_accounts', () => rows);
  transport.onCall('transact', () => ({ status: 'ok', last_sync_id: 1 }));
  setTransport(transport);
  store = new RootStore();
  m = await mount(
    <RootStoreProvider store={store}>
      <AgentAccounts />
    </RootStoreProvider>,
  );
  await settle();
}

const group = (agent: AgentId) =>
  m!.host.querySelector<HTMLElement>(`[data-agent="${agent}"]`)!;
const row = (agent: AgentId, id: string) =>
  group(agent).querySelector<HTMLElement>(`[data-account="${id}"]`);
const text = (el: Element | null | undefined, sel: string) =>
  el?.querySelector(sel)?.textContent ?? null;
const button = (el: Element | null | undefined, name: string) =>
  [...(el?.querySelectorAll('button') ?? [])].find(
    (b) => b.textContent?.trim() === name,
  );

describe('the accounts list', () => {
  it('groups rows per agent with sign-in, limit and the sign-in command', async () => {
    const soon = Date.now() + 3_600_000;
    await render([
      status('claude', 'default', {
        signed_in: true,
        limit: {
          agent: 'claude',
          account: 'default',
          limit: { status: 'ok' },
          at: 1,
        },
      }),
      status('claude', 'work', {
        signed_in: false,
        sign_in_command: WORK_CMD,
        limit: {
          agent: 'claude',
          account: 'work',
          limit: { status: 'limited', resets_at: soon },
          at: 1,
        },
        preferred: false,
      }),
      status('codex', 'default'),
    ]);
    const def = row('claude', 'default');
    expect(text(def, '.account-label')).toBe('default');
    expect(def?.textContent).toContain('~/.claude');
    expect(text(def, '.account-sign-in')).toBe('signed in');
    expect(text(def, '.account-limit')).toBe('ok');
    expect(def?.querySelector('.preferred')).not.toBeNull();
    // The default account has no command, Check again or Remove.
    expect(def?.querySelector('.sign-in-command')).toBeNull();
    expect(button(def, 'Remove')).toBeUndefined();

    const work = row('claude', 'work');
    expect(text(work, '.account-label')).toBe('work');
    expect(text(work, '.account-sign-in')).toBe('not signed in');
    expect(text(work, '.account-limit')).toMatch(/^limited/);
    expect(text(work, '.sign-in-command')).toBe(WORK_CMD);
    expect(work?.querySelector('[aria-label="Copy command"]')).not.toBeNull();

    expect(text(row('codex', 'default'), '.account-sign-in')).toBe(
      'sign-in unknown',
    );
    expect(group('gemini').textContent).toContain('API key');
  });

  it('the live agent_limit row wins over the snapshot', async () => {
    await render([
      status('claude', 'default', {
        limit: {
          agent: 'claude',
          account: 'default',
          limit: { status: 'ok' },
          at: 1,
        },
      }),
    ]);
    act(() => {
      store.sync.pool.put('agent_limit', 'claude:default', {
        id: 'claude:default',
        agent: 'claude',
        account: 'default',
        limit: { status: 'warning', used_pct: 91 },
        at: 2,
      });
    });
    expect(text(row('claude', 'default'), '.account-limit')).toBe(
      'near limit · 91%',
    );
  });

  it('copies the sign-in command', async () => {
    let copied = '';
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (v: string) => void (copied = v) },
    });
    await render([
      status('claude', 'work', { sign_in_command: WORK_CMD, preferred: false }),
    ]);
    await click(
      row('claude', 'work')!.querySelector('[aria-label="Copy command"]'),
    );
    expect(copied).toBe(WORK_CMD);
  });

  it('adds an account and shows its sign-in command', async () => {
    await render([status('claude', 'default')]);
    transport.onCall('add_agent_account', () =>
      status('claude', 'work', {
        sign_in_command: WORK_CMD,
        signed_in: false,
        preferred: false,
      }),
    );
    await click(button(group('claude'), 'Add account'));
    await typeInto(group('claude').querySelector('input'), 'work');
    await click(button(group('claude'), 'Add'));
    await settle();
    const call = transport.calls.find((c) => c.cmd === 'add_agent_account');
    expect(call?.args).toEqual({ req: { agent: 'claude', label: 'work' } });
    expect(text(row('claude', 'work'), '.sign-in-command')).toBe(WORK_CMD);
    // The form closed.
    expect(group('claude').querySelector('input')).toBeNull();
  });

  it('Check again asks again and updates the row', async () => {
    await render([
      status('claude', 'work', {
        signed_in: false,
        sign_in_command: WORK_CMD,
        preferred: false,
      }),
    ]);
    transport.onCall('check_agent_account', () =>
      status('claude', 'work', {
        signed_in: true,
        sign_in_command: WORK_CMD,
        preferred: false,
      }),
    );
    await click(button(row('claude', 'work'), 'Check again'));
    await settle();
    const call = transport.calls.find((c) => c.cmd === 'check_agent_account');
    expect(call?.args).toEqual({
      req: { id: 'work', agent: 'claude', recheck: true },
    });
    expect(text(row('claude', 'work'), '.account-sign-in')).toBe('signed in');
  });

  it('Remove drops the row', async () => {
    await render([
      status('claude', 'default'),
      status('claude', 'work', { preferred: false }),
    ]);
    transport.onCall('remove_agent_account', () => null);
    await click(button(row('claude', 'work'), 'Remove'));
    await settle();
    const call = transport.calls.find((c) => c.cmd === 'remove_agent_account');
    expect(call?.args).toEqual({ req: { id: 'work', agent: 'claude' } });
    expect(row('claude', 'work')).toBeNull();
    expect(row('claude', 'default')).not.toBeNull();
  });

  it('Make preferred writes agents.<agent>.account', async () => {
    const rows = [
      status('claude', 'default'),
      status('claude', 'work', { preferred: false }),
    ];
    await render(rows);
    expect(preferredAccount(store, 'claude', rows)).toBe('default');
    await click(button(row('claude', 'work'), 'Make preferred'));
    await settle();
    expect(preferredAccount(store, 'claude', rows)).toBe('work');
    expect(row('claude', 'work')?.querySelector('.preferred')).not.toBeNull();
    expect(row('claude', 'default')?.querySelector('.preferred')).toBeNull();
  });
});

describe('after a usage limit', () => {
  it('auto-continue is on by default and its switch writes the setting', async () => {
    await render([]);
    expect(isAutoContinue(store)).toBe(true);
    const sw = m!.host.querySelector<HTMLInputElement>(
      'input[aria-label="Continue automatically after a usage limit"]',
    );
    expect(sw?.checked).toBe(true);
    await click(sw);
    await settle();
    expect(isAutoContinue(store)).toBe(false);
  });

  it('fallback agents keep the order they were picked in', async () => {
    await render([]);
    expect(fallbackAgents(store)).toEqual([]);
    const pick = (a: string) =>
      click(
        [
          ...m!.host.querySelectorAll<HTMLElement>('.fallback-agents button'),
        ].find((b) => b.textContent?.endsWith(a)),
      );
    await pick('gemini');
    await settle();
    await pick('codex');
    await settle();
    expect(fallbackAgents(store)).toEqual(['gemini', 'codex']);
    const labels = [...m!.host.querySelectorAll('.fallback-agents button')].map(
      (b) => b.textContent,
    );
    expect(labels).toEqual(['claude', '2. codex', '1. gemini']);
  });

  it('nextFallbacks keeps the kept ones in place, appends new ones', () => {
    expect(nextFallbacks(['gemini'], new Set(['gemini', 'codex']))).toEqual([
      'gemini',
      'codex',
    ]);
    expect(
      nextFallbacks(['gemini', 'codex'], new Set(['codex'] as AgentId[])),
    ).toEqual(['codex']);
  });
});
