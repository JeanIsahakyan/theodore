/** What the fleet puts in front of you wherever you are: routed questions
 *  and "wants to run spaces here" notices. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setTransport } from '../../core/transport';
import { RootStore } from '../../stores/RootStore';
import { RootStoreProvider } from '../../stores/context';
import { click, mount, settle, typeInto, type Mounted } from '../../test/dom';
import {
  device,
  question,
  status,
  thisDevice,
  trustNeeded,
} from '../../test/fleet';
import { FakeTransport } from '../../test/fakeTransport';
import { FleetNotices } from './FleetNotices';

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
});

async function render() {
  m = await mount(
    <RootStoreProvider store={store}>
      <FleetNotices />
    </RootStoreProvider>,
  );
  await settle();
}

const q = <T extends Element = HTMLElement>(sel: string) =>
  m!.host.querySelector<T>(sel);
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
    store.ui.go({ name: 'fleet-space', id: 'rs_1' });
    await render();
    expect(q('.fleet-question')).toBeNull();
    store.ui.go({ name: 'fleet-space', id: 'rs_other' });
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

  it('is named, with its fingerprint', async () => {
    store.fleet.handle({ type: 'fleet_trust_needed', request });
    await render();
    const text = q('.fleet-trust-needed')!.textContent!;
    expect(text).toContain('Studio Mac wants to run spaces here');
    expect(text).toContain(
      'fingerprint a1b2 c3d4 e5f6 0718 9abc def0 1234 5678',
    );
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
    expect(q('.fleet-trust-needed')).toBeNull();
  });

  it('cancelling the check trusts nothing and keeps the notice', async () => {
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
    expect(q('.fleet-trust-needed')).toBeNull();
    expect(calls('fleet_trust_device')).toEqual([]);
  });
});
