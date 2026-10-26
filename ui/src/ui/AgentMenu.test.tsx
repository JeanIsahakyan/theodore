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
  nextEffort,
  setAgentEffort,
  setAgentModel,
} from './agentModel';
import { resetAgentModels } from './useAgentModels';

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
    expect(agentLabel('gemini', null, 'high')).toBe('gemini · default model');
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

const CLAUDE = ['low', 'medium', 'high', 'xhigh', 'max'];
const CATALOG: Record<string, unknown[]> = {
  claude: [
    {
      id: 'opus',
      label: 'Opus',
      description: 'Most capable',
      efforts: CLAUDE,
      default_effort: null,
    },
    {
      id: 'sonnet',
      label: 'Sonnet',
      description: 'Balanced',
      efforts: CLAUDE,
      default_effort: null,
    },
    {
      id: 'haiku',
      label: 'Haiku',
      description: null,
      efforts: CLAUDE,
      default_effort: null,
    },
  ],
  codex: [
    {
      id: 'gpt-6-sol',
      label: 'GPT-6-Sol',
      description: 'Workhorse',
      efforts: ['low', 'medium', 'ultra'],
      default_effort: 'medium',
    },
    {
      id: 'gpt-6-luna',
      label: 'GPT-6-Luna',
      description: null,
      efforts: ['low', 'medium'],
      default_effort: 'medium',
    },
  ],
};

describe('nextEffort', () => {
  it('cycles through the levels and wraps round', () => {
    expect(nextEffort(null)).toBe('low');
    expect(nextEffort('high')).toBe('xhigh');
    expect(nextEffort('max')).toBe('low');
    expect(nextEffort('medium', ['low', 'medium', 'ultra'])).toBe('ultra');
    expect(nextEffort('ultra', ['low', 'medium', 'ultra'])).toBe('low');
    expect(nextEffort('x', [])).toBeNull();
  });
});

describe('AgentMenu', () => {
  let picked: AgentId[] = [];

  beforeEach(() => {
    resetAgentModels();
    picked = [];
    const transport = new FakeTransport();
    setTransport(transport);
    transport.onCall('transact', () => ({ status: 'ok', last_sync_id: 1 }));
    transport.onCall('agent_models', (a) => CATALOG[String(a?.agent)] ?? []);
  });

  async function render(store: RootStore, selected: AgentId[]) {
    m = await mount(
      <RootStoreProvider store={store}>
        <div>
          <textarea aria-label="box" />
          <AgentMenu
            agents={['claude', 'codex']}
            selected={selected}
            onSelect={(next) => (picked = next)}
            multiple
          />
        </div>
      </RootStoreProvider>,
    );
    await settle();
    return m.host.querySelector('button[aria-label="Model"]')!;
  }

  const item = (name: string) =>
    [...document.querySelectorAll('[role^="menuitem"]')].find((el) =>
      el.textContent?.startsWith(name),
    ) as HTMLElement | undefined;

  it('names the model from the catalog, with its effort', async () => {
    const store = new RootStore();
    setAgentModel(store, 'claude', 'opus');
    setAgentEffort(store, 'claude', 'high');
    const chip = await render(store, ['claude']);
    expect(chip.textContent).toBe('Opus High');
  });

  it('names the agent when no model is set, and the extra skill agents', async () => {
    const store = new RootStore();
    const chip = await render(store, ['claude', 'codex']);
    expect(chip.textContent).toBe('Claude + Codex');
  });

  it('lists one row per agent, models in its submenu, no Default', async () => {
    const store = new RootStore();
    const chip = await render(store, ['claude']);
    await click(chip);
    await settle();
    expect(item('Claude')).toBeTruthy();
    expect(item('Codex')).toBeTruthy();
    await click(item('Codex')!);
    await settle();
    expect(item('GPT-6-Sol')).toBeTruthy();
    expect(item('Default')).toBeUndefined();
    await click(item('GPT-6-Sol')!);
    await settle();
    expect(agentModel(store, 'codex')).toBe('gpt-6-sol');
    expect(picked).toEqual(['codex']);
  });

  it("offers the chosen model's own effort levels", async () => {
    const store = new RootStore();
    setAgentModel(store, 'codex', 'gpt-6-sol');
    const chip = await render(store, ['codex']);
    await click(chip);
    await settle();
    await click(item('Effort')!);
    await settle();
    expect(item('Ultra')).toBeTruthy();
    expect(item('Max')).toBeUndefined();
    await click(item('Ultra')!);
    await settle();
    expect(agentEffort(store, 'codex')).toBe('ultra');
  });

  it('drops an effort the new model does not take', async () => {
    const store = new RootStore();
    setAgentModel(store, 'codex', 'gpt-6-sol');
    setAgentEffort(store, 'codex', 'ultra');
    const chip = await render(store, ['codex']);
    await click(chip);
    await settle();
    await click(item('Codex')!);
    await settle();
    await click(item('GPT-6-Luna')!);
    await settle();
    expect(agentEffort(store, 'codex')).toBeNull();
  });

  it('⌘⇧/ in its box cycles the effort', async () => {
    const store = new RootStore();
    setAgentModel(store, 'claude', 'opus');
    setAgentEffort(store, 'claude', 'high');
    await render(store, ['claude']);
    const box = m!.host.querySelector('textarea')!;
    const press = () =>
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          code: 'Slash',
          key: '?',
          metaKey: true,
          shiftKey: true,
        }),
      );
    press(); // focus elsewhere: nothing
    expect(agentEffort(store, 'claude')).toBe('high');
    box.focus();
    press();
    await settle();
    expect(agentEffort(store, 'claude')).toBe('xhigh');
  });
});
