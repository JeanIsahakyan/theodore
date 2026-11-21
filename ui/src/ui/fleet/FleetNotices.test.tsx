/** What the fleet puts in front of you wherever you are: routed questions
 *  as cards, and the decisions waiting on you as a dialog, one at a time. */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setTransport } from '../../core/transport';
import { RootStore } from '../../stores/RootStore';
import { RootStoreProvider } from '../../stores/context';
import { click, mount, settle, typeInto, type Mounted } from '../../test/dom';
import {
  confirmRequest,
  device,
  question,
  status,
  thisDevice,
  trustNeeded,
} from '../../test/fleet';
import { FakeTransport } from '../../test/fakeTransport';
import * as native from '../../core/native';
import { FleetNotices } from './FleetNotices';

// jsdom has no CSS.escape; the modal's keyboard handling asks for it.
globalThis.CSS ??= {
  escape: (s: string) => s.replace(/[^\w-]/g, '\\$&'),
} as unknown as typeof CSS;

let transport: FakeTransport;
let store: RootStore;
let m: Mounted | null = null;

beforeEach(() => {
  transport = new FakeTransport();
  transport.onCall('fleet_answer', () => null);
  setTransport(transport);
  store = new RootStore();
  store.fleet.setStatus(status());
});

afterEach(() => {
  m?.unmount();
  m = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

async function render() {
  m = await mount(
    <RootStoreProvider store={store}>
      <FleetNotices />
    </RootStoreProvider>,
  );
  await settle();
}

// The dialog lives in a portal: look in the whole document.
const q = <T extends Element = HTMLElement>(sel: string) =>
  document.querySelector<T>(sel);
const dialog = () => q('.fleet-prompt');
const key = (k: string, over: KeyboardEventInit = {}) =>
  act(() => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent('keydown', { key: k, bubbles: true, ...over }),
    );
  });
const calls = (cmd: string) =>
  transport.calls.filter((c) => c.cmd === cmd).map((c) => c.args);

describe('a routed question', () => {
  it('appears, says where it is from, and goes when dismissed', async () => {
    await render();
    expect(q('.fleet-question')).toBeNull();

    store.fleet.handle({ type: 'fleet_ask', question: question() });
    await settle();
    expect(q('.fleet-question')!.textContent).toContain(
      'Studio Mac · fix login',
    );
    expect(q('.fleet-question')!.textContent).toContain('Which database?');

    store.fleet.handle({ type: 'fleet_ask_dismissed', ask_id: 'ask1' });
    await settle();
    expect(q('.fleet-question')).toBeNull();
  });

  it('is answered inline, and goes', async () => {
    store.fleet.handle({ type: 'fleet_ask', question: question() });
    await render();
    await click(
      [...m!.host.querySelectorAll('.fleet-option')].find(
        (b) => b.textContent === 'sqlite',
      ),
    );
    await click(q('.fleet-answer'));
    await settle();
    expect(calls('fleet_answer')).toEqual([
      { req: { space: 'rs_1', ask_id: 'ask1', answers: [['sqlite']] } },
    ]);
    expect(q('.fleet-question')).toBeNull();
  });

  it('takes free text under Other', async () => {
    store.fleet.handle({ type: 'fleet_ask', question: question() });
    await render();
    await typeInto(
      q('input[aria-label="Other answer to: Which database?"]'),
      'duckdb',
    );
    await click(q('.fleet-answer'));
    await settle();
    expect(
      (calls('fleet_answer')[0] as { req: { answers: string[][] } }).req
        .answers,
    ).toEqual([['duckdb']]);
  });

  it("is not repeated over the space's own page", async () => {
    store.fleet.handle({ type: 'fleet_ask', question: question() });
    store.ui.go({ name: 'space', id: 'rs_1' });
    await render();
    expect(q('.fleet-question')).toBeNull();
    store.ui.go({ name: 'space', id: 'rs_other' });
    await settle();
    expect(q('.fleet-question')).not.toBeNull();
  });

  it('stays hidden where there is no fleet', async () => {
    store.fleet.setStatus(status({ available: false }));
    store.fleet.handle({ type: 'fleet_ask', question: question() });
    await render();
    expect(m!.host.textContent).toBe('');
  });
});

describe('a device that wants to run spaces here', () => {
  const request = trustNeeded();

  it('asks in a dialog, named, with its fingerprint', async () => {
    store.fleet.handle({ type: 'fleet_trust_needed', request });
    await render();
    const text = q('.fleet-trust-needed')!.textContent!;
    expect(text).toContain('Studio Mac wants to run spaces here');
    expect(q('.fleet-trust-needed .fingerprint')!.textContent).toBe(
      'a1b2 c3d4 e5f6 0718 9abc def0 1234 5678',
    );
    expect(dialog()!.getAttribute('role')).toBe('alertdialog');
  });

  it('Trust asks to compare the fingerprint first, then pins the key it showed', async () => {
    store.fleet.handle({ type: 'fleet_trust_needed', request });
    transport.onCall('fleet_trust_device', () =>
      status({ devices: [thisDevice(), device({ trusted: true })] }),
    );
    await render();
    await click(q('.fleet-trust-accept'));
    await settle();
    expect(calls('fleet_trust_device')).toEqual([]);
    const confirm = q('.fleet-trust-needed .fleet-confirm')!;
    expect(confirm.textContent).toContain(
      'Make sure Studio Mac shows the same fingerprint',
    );
    expect(confirm.querySelector('.fingerprint')!.textContent).toBe(
      'a1b2 c3d4 e5f6 0718 9abc def0 1234 5678',
    );

    await click(q('.fleet-confirm-trust'));
    await settle();
    expect(calls('fleet_trust_device')).toEqual([
      {
        req: {
          device_id: 'd2',
          trusted: true,
          public_key: 'pk-studio-mac-asked',
        },
      },
    ]);
    expect(dialog()).toBeNull();
  });

  it('cancelling the check trusts nothing and keeps the prompt', async () => {
    store.fleet.handle({ type: 'fleet_trust_needed', request });
    await render();
    await click(q('.fleet-trust-accept'));
    await click(q('.fleet-confirm-cancel'));
    expect(q('.fleet-confirm')).toBeNull();
    expect(q('.fleet-trust-needed')).not.toBeNull();
    expect(calls('fleet_trust_device')).toEqual([]);
  });

  it('Dismiss removes it and trusts nothing', async () => {
    store.fleet.handle({ type: 'fleet_trust_needed', request });
    await render();
    await click(q('.fleet-trust-dismiss'));
    expect(dialog()).toBeNull();
    expect(store.fleet.trustNeededList).toEqual([]);
    expect(calls('fleet_trust_device')).toEqual([]);
  });

  it('Claude via the cloud is named as such, with its warning', async () => {
    store.fleet.handle({
      type: 'fleet_trust_needed',
      request: trustNeeded({ kind: 'mcp', device_name: 'Claude' }),
    });
    await render();
    expect(q('.fleet-trust-needed .fleet-mcp-warning')!.textContent).toContain(
      'held by the Theodore cloud',
    );
  });
});

describe('a request from Claude via the cloud', () => {
  beforeEach(() => {
    transport.onCall('fleet_confirm', () => null);
  });

  it('opens a dialog: what it would do, the goal as plain text, the warning', async () => {
    store.fleet.handle({
      type: 'fleet_confirm',
      request: confirmRequest({ text: '<b>Fix</b> the login bug' }),
    });
    await render();
    const card = q('.fleet-request-confirm')!;
    expect(dialog()!.contains(card)).toBe(true);
    expect(card.textContent).toContain(
      'Claude via cloud wants to start an Edit space in app',
    );
    expect(q('.fleet-request-text')!.textContent).toBe(
      '<b>Fix</b> the login bug',
    );
    expect(card.querySelector('b')).toBeNull();
    expect(card.textContent).toContain('From Claude');
    expect(q('.fleet-mcp-warning')!.textContent).toContain(
      'held by the Theodore cloud',
    );
    expect(q('.fleet-request-countdown')!.textContent).toMatch(
      /Refused automatically in [45]:\d\d/,
    );
    // No queue for one.
    expect(q('.fleet-prompt-count')).toBeNull();
  });

  it('starts with focus on no button, and Enter allows nothing', async () => {
    store.fleet.handle({ type: 'fleet_confirm', request: confirmRequest() });
    await render();
    expect(document.activeElement?.tagName).not.toBe('BUTTON');
    await key('Enter');
    await settle();
    expect(calls('fleet_confirm')).toEqual([]);
    expect(dialog()).not.toBeNull();
  });

  it('Cmd+Enter allows', async () => {
    store.fleet.handle({ type: 'fleet_confirm', request: confirmRequest() });
    await render();
    await key('Enter', { metaKey: true });
    await settle();
    expect(calls('fleet_confirm')).toEqual([
      { req: { id: 'req1', allow: true } },
    ]);
  });

  it('Allow sends a yes and the dialog goes', async () => {
    store.fleet.handle({ type: 'fleet_confirm', request: confirmRequest() });
    await render();
    await click(q('.fleet-request-allow'));
    await settle();
    expect(calls('fleet_confirm')).toEqual([
      { req: { id: 'req1', allow: true } },
    ]);
    expect(dialog()).toBeNull();
  });

  it('Deny sends a no', async () => {
    store.fleet.handle({ type: 'fleet_confirm', request: confirmRequest() });
    await render();
    await click(q('.fleet-request-deny'));
    await settle();
    expect(calls('fleet_confirm')).toEqual([
      { req: { id: 'req1', allow: false } },
    ]);
    expect(dialog()).toBeNull();
  });

  it('closes when answered elsewhere', async () => {
    store.fleet.handle({ type: 'fleet_confirm', request: confirmRequest() });
    await render();
    expect(dialog()).not.toBeNull();
    store.fleet.handle({ type: 'fleet_confirm_done', id: 'req1' });
    await settle();
    expect(dialog()).toBeNull();
    expect(calls('fleet_confirm')).toEqual([]);
  });

  it('closes once out of time, even before the core says so', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    try {
      store.fleet.handle({
        type: 'fleet_confirm',
        request: confirmRequest({ expires_at_ms: Date.now() + 2_000 }),
      });
      await render();
      expect(dialog()).not.toBeNull();
      await act(async () => {
        vi.advanceTimersByTime(3_000);
      });
      expect(dialog()).toBeNull();
      expect(calls('fleet_confirm')).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('notifies the system while the window is in the background', async () => {
    const notify = vi.spyOn(native, 'notifySpace').mockResolvedValue(true);
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    await render();
    store.fleet.handle({
      type: 'fleet_confirm',
      request: confirmRequest({ local_space: 's1' }),
    });
    await settle();
    expect(notify).toHaveBeenCalledWith(
      's1',
      'Claude via cloud wants to start an Edit space in app',
      'Fix the login bug',
    );
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

describe('several decisions', () => {
  beforeEach(() => {
    transport.onCall('fleet_confirm', () => null);
    store.fleet.handle({
      type: 'fleet_confirm',
      request: confirmRequest({ id: 'a', expires_at_ms: Date.now() + 60_000 }),
    });
    store.fleet.handle({
      type: 'fleet_confirm',
      request: confirmRequest({
        id: 'b',
        expires_at_ms: Date.now() + 120_000,
        action: 'send',
        space_name: 'Fix login',
      }),
    });
    store.fleet.handle({
      type: 'fleet_trust_needed',
      request: trustNeeded(),
    });
  });

  it('queue one at a time, "1 of 3", the next after an answer', async () => {
    await render();
    expect(document.querySelectorAll('.fleet-prompt')).toHaveLength(1);
    expect(q('.fleet-prompt-count')!.textContent).toBe('1 of 3');
    expect(q('.fleet-request-confirm')!.dataset.request).toBe('a');
    await click(q('.fleet-request-deny'));
    await settle();
    expect(q('.fleet-prompt-count')!.textContent).toBe('1 of 2');
    expect(q('.fleet-request-confirm')!.textContent).toContain(
      'send to Fix login in Edit',
    );
    await click(q('button[aria-label="Next request"]'));
    expect(q('.fleet-trust-needed')).not.toBeNull();
    expect(q('.fleet-prompt-count')!.textContent).toBe('2 of 2');
  });

  it('Esc puts them away unanswered; a new one brings the dialog back', async () => {
    await render();
    await key('Escape');
    await settle();
    expect(dialog()).toBeNull();
    expect(calls('fleet_confirm')).toEqual([]);
    expect(store.fleet.confirmList).toHaveLength(2);
    expect(store.fleet.trustNeededList).toHaveLength(1);

    store.fleet.handle({
      type: 'fleet_confirm',
      request: confirmRequest({ id: 'c', expires_at_ms: Date.now() + 200_000 }),
    });
    await settle();
    expect(q('.fleet-request-confirm')!.dataset.request).toBe('c');
    expect(q('.fleet-prompt-count')!.textContent).toBe('3 of 4');
  });

  it('"Decide later" puts them away; reopening shows the queue again', async () => {
    await render();
    await click(q('button[aria-label="Decide later"]'));
    await settle();
    expect(dialog()).toBeNull();
    store.fleet.reopenPrompts();
    await settle();
    expect(q('.fleet-prompt-count')!.textContent).toBe('1 of 3');
  });
});

describe('a prompt waiting on another computer', () => {
  beforeEach(() => {
    transport.onCall('fleet_confirm', () => null);
  });

  it('names that computer and sends the answer the same way', async () => {
    store.fleet.handle({
      type: 'fleet_confirm',
      request: confirmRequest({
        id: 'c9',
        host_device: 'd2',
        host_name: 'Studio Mac',
      }),
    });
    await render();
    const card = q('.fleet-request-confirm')!;
    expect(card.textContent).toContain(
      'Claude via cloud wants to start an Edit space in app on Studio Mac',
    );
    expect(q('.fleet-request-host')!.textContent).toBe(
      'Waiting on Studio Mac. Your answer goes there.',
    );
    await click(q('.fleet-request-allow'));
    await settle();
    expect(calls('fleet_confirm')).toEqual([
      { req: { id: 'c9', allow: true } },
    ]);
  });
});
