import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { click, mount, settle, type Mounted } from '../test/dom';
import { setTransport } from '../core/transport';
import { RootStore } from '../stores/RootStore';
import { RootStoreProvider } from '../stores/context';
import { FakeTransport } from '../test/fakeTransport';
import { setSetting } from '../actions';
import type { AgentId } from '../gen/contract';
import { AgentMenu } from './AgentMenu';
import {
  agentEffort,
  agentLabel,
  agentLabelOf,
  agentModel,
  setAgentEffort,
  setAgentModel,
} from './agentModel';

let m: Mounted | null = null;

// jsdom has no `CSS.escape`; an open react-aria popover calls it.
(globalThis as { CSS?: { escape?: (s: string) => string } }).CSS ??= {};
globalThis.CSS.escape ??= (s: string) =>
  s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);

beforeEach(() => {
  const transport = new FakeTransport();
  setTransport(transport);
  transport.onCall('transact', () => ({ status: 'ok', last_sync_id: 1 }));
});

afterEach(() => {
  m?.unmount();
  m = null;
});

describe('agentLabel', () => {
  it('names the model, or says it is the default', () => {
    expect(agentLabel('claude', null, null)).toBe('claude · default model');
    expect(agentLabel('claude', 'opus', null)).toBe('claude · Opus');
    expect(agentLabel('claude', 'opus', 'high')).toBe('claude · Opus · High');
    expect(agentLabel('claude', null, 'max')).toBe(
      'claude · default model · Max',
    );
  });

  it('shows a full model name as typed', () => {
    expect(agentLabel('claude', 'claude-opus-4-1', null)).toBe(
      'claude · claude-opus-4-1',
    );
    expect(agentLabel('codex', 'gpt-5', null)).toBe('codex · gpt-5');
  });

  it('never shows an effort for an agent without the flag', () => {
    expect(agentLabel('codex', null, 'high')).toBe('codex · default model');
  });
});

describe('agent model and effort settings', () => {
  it('reads agents.<id>.model / .effort, user scope', () => {
    const store = new RootStore();
    expect(agentModel(store, 'claude')).toBeNull();
    setAgentModel(store, 'claude', 'sonnet');
    setAgentEffort(store, 'claude', 'xhigh');
    expect(agentModel(store, 'claude')).toBe('sonnet');
    expect(agentEffort(store, 'claude')).toBe('xhigh');
    expect(agentLabelOf(store, 'claude')).toBe('claude · Sonnet · Extra high');
    // Per agent.
    expect(agentModel(store, 'codex')).toBeNull();
  });

  it('treats null, blank and unknown efforts as unset', () => {
    const store = new RootStore();
    setAgentModel(store, 'claude', '  ');
    setSetting(store, 'user', 'agents.claude.effort', 'ultra');
    expect(agentModel(store, 'claude')).toBeNull();
    expect(agentEffort(store, 'claude')).toBeNull();
    setAgentModel(store, 'claude', 'opus');
    setAgentModel(store, 'claude', null);
    expect(agentModel(store, 'claude')).toBeNull();
  });
});

describe('AgentMenu', () => {
  async function render(store: RootStore, selected: AgentId[]) {
    m = await mount(
      <RootStoreProvider store={store}>
        <AgentMenu
          agents={['claude', 'codex']}
          selected={selected}
          onSelect={() => {}}
          multiple
        />
      </RootStoreProvider>,
    );
    await settle();
    return m.host.querySelector('button[aria-label="Agent"]')!;
  }

  it('says which model and effort the chip runs with', async () => {
    const store = new RootStore();
    setAgentModel(store, 'claude', 'opus');
    setAgentEffort(store, 'claude', 'high');
    const chip = await render(store, ['claude']);
    expect(chip.textContent).toBe('claude · Opus · High');
  });

  it('says "default model" when none is set, for each agent', async () => {
    const store = new RootStore();
    const chip = await render(store, ['claude', 'codex']);
    expect(chip.textContent).toBe(
      'claude · default model + codex · default model',
    );
  });

  it('picking a model and an effort writes the agent settings', async () => {
    const store = new RootStore();
    const chip = await render(store, ['claude']);
    const item = (name: string) =>
      [...document.querySelectorAll('[role^="menuitem"]')].find((el) =>
        el.textContent?.startsWith(name),
      );
    await click(chip);
    await settle();
    expect(item('Opus')).toBeTruthy();
    // codex isn't selected: no model or effort section for it.
    expect(document.body.textContent).not.toContain('codex model');
    await click(item('Opus'));
    await settle();
    expect(agentModel(store, 'claude')).toBe('opus');
    await click(chip);
    await settle();
    await click(item('Max'));
    await settle();
    expect(agentEffort(store, 'claude')).toBe('max');
    expect(chip.textContent).toBe('claude · Opus · Max');
  });
});
