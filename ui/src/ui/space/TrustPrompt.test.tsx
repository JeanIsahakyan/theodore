/** The trust card's answers wait until it has been on screen a moment: a
 *  stray click landing as it appears can't answer it. */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Space, SpaceConfigView } from '../../gen/contract';
import { setTransport } from '../../core/transport';
import { click, mount, type Mounted } from '../../test/dom';
import { FakeTransport } from '../../test/fakeTransport';
import { TRUST_ARM_MS, TrustPrompt } from './SpaceCommands';

const space = { id: 's1', status: 'idle' } as Space;

const config = (hash: string, denied = false) =>
  ({
    commands: [],
    ports: [],
    denied,
    repo_commands: {
      hash,
      trusted: false,
      items: [{ key: 'spaces.setup', value: 'pnpm install' }],
    },
  }) as unknown as SpaceConfigView;

let transport: FakeTransport;
let m: Mounted | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  transport = new FakeTransport();
  transport.onCall('space_trust', () => space);
  setTransport(transport);
});

afterEach(() => {
  m?.unmount();
  m = null;
  vi.useRealTimers();
});

const render = async (c: SpaceConfigView | null) => {
  const node = <TrustPrompt space={space} config={c} onChanged={() => {}} />;
  if (m) await act(async () => m!.root.render(node));
  else m = await mount(node);
};
const allow = () =>
  document.querySelector<HTMLButtonElement>('.space-trust-allow')!;
const deny = () =>
  document.querySelector<HTMLButtonElement>('.space-trust-deny')!;
const pass = (ms: number) =>
  act(async () => {
    vi.advanceTimersByTime(ms);
  });
const answers = () => transport.calls.filter((c) => c.cmd === 'space_trust');

describe('TrustPrompt', () => {
  it('takes no answer until it has been up for the delay', async () => {
    await render(config('h1'));
    expect(allow().disabled).toBe(true);
    expect(deny().disabled).toBe(true);
    await click(allow());
    await click(deny());

    await pass(TRUST_ARM_MS - 1);
    expect(allow().disabled).toBe(true);
    await click(allow());
    expect(answers()).toHaveLength(0);

    await pass(1);
    expect(allow().disabled).toBe(false);
    expect(deny().disabled).toBe(false);
    await click(allow());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(answers()).toHaveLength(1);
    expect(answers()[0]!.args?.req).toEqual({
      space: 's1',
      allow: true,
      hash: 'h1',
    });
  });

  it('counts from when the card appears, not from when the page did', async () => {
    await render(null);
    await pass(TRUST_ARM_MS * 3);
    await render(config('h1'));
    expect(allow().disabled).toBe(true);
    await pass(TRUST_ARM_MS);
    expect(allow().disabled).toBe(false);
  });

  it('waits again when the commands it shows change', async () => {
    await render(config('h1'));
    await pass(TRUST_ARM_MS);
    expect(allow().disabled).toBe(false);
    await render(config('h2'));
    expect(allow().disabled).toBe(true);
    await pass(TRUST_ARM_MS);
    expect(allow().disabled).toBe(false);
  });

  it('waits again when Review… opens it after Not now', async () => {
    await render(config('h1', true));
    await pass(TRUST_ARM_MS * 3);
    const review = [...document.querySelectorAll('button')].find((b) =>
      b.textContent?.startsWith('Review'),
    );
    await click(review);
    expect(allow().disabled).toBe(true);
    await pass(TRUST_ARM_MS);
    expect(allow().disabled).toBe(false);
  });
});
