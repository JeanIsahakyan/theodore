/** New space: Create on an empty form, `/` in the goal box, and what the
 *  dialog sends. Its picks are the new space's alone: nothing here writes a
 *  setting. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import type { SkillInfo } from '../../gen/contract';
import { setCommandFailureHandler } from '../../core/api';
import { setTransport } from '../../core/transport';
import { RootStore } from '../../stores/RootStore';
import { RootStoreProvider } from '../../stores/context';
import { click, mount, settle, typeInto, type Mounted } from '../../test/dom';
import { FakeTransport } from '../../test/fakeTransport';
import { resetAgentModels } from '../useAgentModels';
import { NewSpaceModal } from './SpacePage';

// jsdom has no `CSS.escape`; an open react-aria modal calls it.
(globalThis as { CSS?: { escape?: (s: string) => string } }).CSS ??= {};
globalThis.CSS.escape ??= (s: string) =>
  s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);

const SKILLS: SkillInfo[] = [
  {
    id: 'docs',
    title: 'docs',
    description: 'Update the docs',
    source: 'acme/app · .claude/skills',
  },
];

const PROJECT = {
  id: 'p1',
  repo: { host: 'github', owner: 'acme', name: 'app' },
  path: null,
  default_branch: 'main',
  status: 'ready',
  error: null,
};

const CATALOG = [
  {
    id: 'claude-opus-5-5',
    label: 'Opus 5.5',
    description: null,
    efforts: ['low', 'medium', 'high'],
    default_effort: 'medium',
    older: false,
  },
];

let transport: FakeTransport;
let store: RootStore;
let m: Mounted | null = null;

const created = () =>
  transport.calls
    .filter((c) => c.cmd === 'create_space')
    .map((c) => c.args?.req as Record<string, unknown>);

beforeEach(() => {
  resetAgentModels();
  transport = new FakeTransport();
  transport.onCall('detect_agents', () => [
    { id: 'claude', installed: true, version: '1', path: '/bin/claude' },
  ]);
  transport.onCall('agent_models', () => CATALOG);
  transport.onCall('project_skills', () => SKILLS);
  transport.onCall('project_issues', () => []);
  transport.onCall('create_space', () => ({ id: 's1' }));
  setTransport(transport);
  store = new RootStore();
  store.sync.pool.put('project', PROJECT.id, PROJECT);
});

afterEach(() => {
  m?.unmount();
  m = null;
});

async function open() {
  m = await mount(
    <RootStoreProvider store={store}>
      <NewSpaceModal />
    </RootStoreProvider>,
  );
  await settle();
  await settle();
}

const box = () => document.querySelector('textarea')!;
const createButton = () =>
  [...document.querySelectorAll('button')].find((b) =>
    b.textContent?.trim().startsWith('Create'),
  ) as HTMLButtonElement;

describe('New space', () => {
  it('creates a blank space from an untouched form', async () => {
    await open();
    expect(createButton().disabled).toBe(false);
    await click(createButton());
    await settle();

    expect(created()).toHaveLength(1);
    const req = created()[0]!;
    expect(req.goal).toBe('');
    expect(req.start_from).toBeNull();
  });

  it('sends the model and effort it shows, and writes no setting', async () => {
    await open();
    await click(createButton());
    await settle();

    const req = created()[0]!;
    expect(req.agent).toBe('claude');
    expect(req.model).toBe('claude-opus-5-5');
    expect(req.effort).toBe('medium');
    expect(req.mode).toBe('edit');
    // No `agents.<id>.model` / `.effort` filled in behind your back.
    expect(transport.calls.some((c) => c.cmd === 'transact')).toBe(false);
  });

  it('offers the skills a space of this project would see, after /', async () => {
    await open();
    expect(
      transport.calls.some(
        (c) => c.cmd === 'project_skills' && c.args?.project === 'p1',
      ),
    ).toBe(true);
    await typeInto(box(), '/do');
    await settle();
    expect(document.querySelector('.slash-menu')?.textContent).toContain(
      '/docs',
    );
  });

  it('a picked skill starts the space with it as the first message', async () => {
    await open();
    await typeInto(box(), '/do');
    await settle();
    await act(async () => {
      box().dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await settle();
    expect(box().value).toBe('/docs ');

    await click(createButton());
    await settle();
    expect(created()[0]!.goal).toBe('/docs');
  });

  it('/report files a report about the new space, not a first turn', async () => {
    transport.onCall('draft_report', () => ({}));
    await open();
    await typeInto(box(), '/report the agent ignored me');
    await click(createButton());
    await settle();

    expect(created()[0]!.goal).toBe('');
    const drafted = transport.calls.find((c) => c.cmd === 'draft_report');
    expect(drafted?.args?.req).toMatchObject({
      chat: 'space:s1',
      description: 'the agent ignored me',
    });
  });

  describe('from a PR', () => {
    async function fromPr() {
      await open();
      await click(
        document.querySelector('button[aria-label="Start from"]') as Element,
      );
      await settle();
      const row = [...document.querySelectorAll('[role^="menuitem"]')].find(
        (el) => /PR/.test(el.textContent ?? ''),
      );
      await click(row);
      await settle();
    }
    const field = () =>
      document.querySelector<HTMLInputElement>(
        'input[aria-label="PR number or URL"]',
      )!;
    const alert = () => document.querySelector('[role="alert"]')?.textContent;

    it.each([
      ['#15', 15],
      ['15', 15],
      ['https://github.com/acme/app/pull/15/files', 15],
    ])('starts from %s', async (typed, number) => {
      await fromPr();
      await typeInto(field(), typed);
      await click(createButton());
      await settle();
      expect(created()[0]!.start_from).toEqual({ kind: 'pr', value: number });
      expect(alert()).toBeUndefined();
    });

    it('says what is wrong with a ref it can read nothing from', async () => {
      await fromPr();
      await typeInto(field(), 'abc');
      expect(createButton().disabled).toBe(false);
      await click(createButton());
      await settle();
      expect(created()).toHaveLength(0);
      expect(alert()).toContain('Enter a PR');
    });

    it('says it too with a goal and an empty field', async () => {
      await fromPr();
      await typeInto(box(), 'Fix the login');
      await click(createButton());
      await settle();
      expect(created()).toHaveLength(0);
      expect(alert()).toContain('Enter a PR');
    });

    it('shows the host refusing the PR, and stays open', async () => {
      const toast = vi.fn();
      setCommandFailureHandler(toast);
      transport.onCall('create_space', () => {
        throw { code: 'not_found', message: 'PR #15 not found' };
      });
      await fromPr();
      await typeInto(field(), '#15');
      await click(createButton());
      await settle();
      expect(toast).toHaveBeenCalledTimes(1);
      expect(field()).toBeTruthy();
    });
  });

  it('keeps a typed goal as today', async () => {
    await open();
    await typeInto(box(), 'Fix the login');
    await click(createButton());
    await settle();
    expect(created()[0]!.goal).toBe('Fix the login');
  });
});
