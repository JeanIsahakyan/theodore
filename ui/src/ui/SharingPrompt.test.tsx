import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TelemetryStatus } from '../gen/contract';
import { setTransport } from '../core/transport';
import { RootStore } from '../stores/RootStore';
import { RootStoreProvider } from '../stores/context';
import { FakeTransport } from '../test/fakeTransport';
import {
  SharingPrompt,
  needsConsent,
  needsSharingChoice,
} from './SharingPrompt';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no CSS.escape; the modal's keyboard handling asks for it.
globalThis.CSS ??= {
  escape: (s: string) => s.replace(/[^\w-]/g, '\\$&'),
} as unknown as typeof CSS;

const status = (over: Partial<TelemetryStatus> = {}): TelemetryStatus => ({
  usage_available: true,
  errors_available: true,
  usage: null,
  errors: null,
  usage_needs_consent: false,
  errors_needs_consent: false,
  events: [],
  never_sent: [],
  ...over,
});

describe('needsSharingChoice', () => {
  it('asks while an available sink has no recorded choice', () => {
    expect(needsSharingChoice(status())).toBe(true);
    expect(needsSharingChoice(status({ usage: true }))).toBe(true);
  });

  it('stays quiet once chosen, or when the build sends nothing', () => {
    expect(needsSharingChoice(status({ usage: false, errors: true }))).toBe(
      false,
    );
    expect(
      needsSharingChoice(
        status({ usage_available: false, errors_available: false }),
      ),
    ).toBe(false);
  });
});

describe('needsConsent', () => {
  it('asks about a switch on under the old terms, if its sink exists', () => {
    expect(needsConsent(status({ usage_needs_consent: true }))).toBe(true);
    expect(needsConsent(status({ errors_needs_consent: true }))).toBe(true);
    expect(
      needsConsent(
        status({ usage_needs_consent: true, usage_available: false }),
      ),
    ).toBe(false);
    expect(needsConsent(status())).toBe(false);
  });
});

const signedIn = {
  available: true,
  required: true,
  user: { id: 'user_01ABC', email: 'a@b.c', name: null, avatar_url: null },
  session_ended: false,
};

describe('SharingPrompt', () => {
  let transport: FakeTransport;
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    sessionStorage.clear();
    transport = new FakeTransport();
    setTransport(transport);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = '';
  });

  async function render(account: typeof signedIn | null = null) {
    const store = new RootStore();
    if (account) store.ephemeral.setAccount(account);
    await act(async () =>
      root.render(
        <RootStoreProvider store={store}>
          <SharingPrompt />
        </RootStoreProvider>,
      ),
    );
    return store;
  }

  const button = (text: string) =>
    [...document.querySelectorAll('button')].find(
      (b) => b.textContent === text,
    );
  const atOldTerms = (over: Partial<TelemetryStatus> = {}) =>
    status({
      usage: true,
      errors: false,
      usage_needs_consent: true,
      ...over,
    });

  it('records the choice and goes away', async () => {
    let saved: unknown = null;
    transport.onCall('telemetry_status', () => status());
    transport.onCall('set_telemetry', (args) => {
      saved = args;
      return status({ usage: true, errors: true });
    });
    await render();
    expect(document.body.textContent).toContain('Help improve Theodore');
    const save = [...document.querySelectorAll('button')].find(
      (b) => b.textContent === 'Save',
    );
    await act(async () => save?.click());
    // Chosen reading the new words: agreement to them.
    expect(saved).toEqual({
      req: {
        usage: true,
        errors: true,
        usage_consent: true,
        errors_consent: true,
      },
    });
    expect(document.querySelector('.sharing-prompt')).toBeNull();
  });

  it("doesn't show once a choice exists", async () => {
    transport.onCall('telemetry_status', () =>
      status({ usage: false, errors: false }),
    );
    await render(signedIn);
    expect(document.querySelector('.sharing-prompt')).toBeNull();
  });

  it('asks a new user the normal first-run choice, not about the account link', async () => {
    transport.onCall('telemetry_status', () => status());
    await render(signedIn);
    expect(document.body.textContent).toContain('Help improve Theodore');
    expect(button('Stop sharing')).toBeUndefined();
  });

  it('never asks someone who said no', async () => {
    transport.onCall('telemetry_status', () =>
      status({ usage: false, errors: false }),
    );
    await render(signedIn);
    expect(document.querySelector('.sharing-prompt')).toBeNull();
  });

  describe('at the old terms', () => {
    let saved: unknown;

    beforeEach(() => {
      saved = undefined;
      transport.onCall('set_telemetry', (args) => {
        saved = args;
        return status();
      });
    });

    it('waits for sign-in: nothing to link without an account', async () => {
      transport.onCall('telemetry_status', () => atOldTerms());
      await render();
      expect(document.querySelector('.sharing-prompt')).toBeNull();
    });

    it('says what changed and offers both answers the same way', async () => {
      transport.onCall('telemetry_status', () => atOldTerms());
      await render(signedIn);
      const text = document.querySelector('.sharing-prompt')?.textContent;
      expect(text).toContain("account's id");
      expect(text).toContain('it stays anonymous');
      expect(text).toContain("What's collected");
      expect(text).toContain('file paths, repository names or your email');
      const [keep, stop] = [
        button('Keep sharing, linked to my account'),
        button('Stop sharing'),
      ];
      expect(keep?.className).toBe(stop?.className);
      expect(keep).toBeDefined();
      expect(document.activeElement).not.toBe(keep);
    });

    it('keeps sharing under the new terms, only for what it asked about', async () => {
      transport.onCall('telemetry_status', () => atOldTerms());
      await render(signedIn);
      await act(async () =>
        button('Keep sharing, linked to my account')?.click(),
      );
      expect(saved).toEqual({
        req: {
          usage: true,
          errors: false,
          usage_consent: true,
          errors_consent: false,
        },
      });
      expect(document.querySelector('.sharing-prompt')).toBeNull();
    });

    it('stops only the switch it asked about', async () => {
      transport.onCall('telemetry_status', () =>
        atOldTerms({ errors: true, errors_needs_consent: false }),
      );
      await render(signedIn);
      await act(async () => button('Stop sharing')?.click());
      expect(saved).toEqual({ req: { usage: false, errors: true } });
    });

    it('asks about error reports the same way, in plain terms', async () => {
      transport.onCall('telemetry_status', () =>
        atOldTerms({
          usage: false,
          usage_needs_consent: false,
          errors: true,
          errors_needs_consent: true,
        }),
      );
      await render(signedIn);
      const text = document.querySelector('.sharing-prompt')?.textContent;
      expect(text).toContain('your error reports');
      expect(text).toContain('they stay anonymous');
      expect(text).toContain('hash repository names');
    });

    it('stays out of the way once dismissed, and asks again on a later launch', async () => {
      transport.onCall('telemetry_status', () => atOldTerms());
      await render(signedIn);
      const close = document.querySelector<HTMLElement>(
        '.sharing-prompt button[aria-label="Close"]',
      );
      await act(async () => close?.click());
      expect(document.querySelector('.sharing-prompt')).toBeNull();
      expect(saved).toBeUndefined();

      // Later in the same launch (a sign-out and back, a re-render).
      act(() => root.unmount());
      root = createRoot(host);
      await render(signedIn);
      expect(document.querySelector('.sharing-prompt')).toBeNull();

      // A later launch: the webview's session is gone.
      sessionStorage.clear();
      act(() => root.unmount());
      root = createRoot(host);
      await render(signedIn);
      expect(document.querySelector('.sharing-prompt')).not.toBeNull();
    });
  });

  describe('with another dialog open', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('waits for a dialog owned by another component, then shows', async () => {
      const dialog = document.createElement('div');
      dialog.setAttribute('role', 'dialog');
      document.body.appendChild(dialog);
      transport.onCall('telemetry_status', () => atOldTerms());
      await render(signedIn);
      expect(document.querySelector('.sharing-prompt')).toBeNull();

      dialog.remove();
      await act(async () => vi.advanceTimersByTime(1100));
      expect(document.querySelector('.sharing-prompt')).not.toBeNull();
    });

    it('waits for a named modal, and comes back when it closes', async () => {
      transport.onCall('telemetry_status', () => atOldTerms());
      const store = await render(signedIn);
      expect(document.querySelector('.sharing-prompt')).not.toBeNull();

      await act(async () => store.ui.openModal('help'));
      expect(document.querySelector('.sharing-prompt')).toBeNull();

      await act(async () => store.ui.closeModal());
      expect(document.querySelector('.sharing-prompt')).not.toBeNull();
    });

    it("doesn't count itself as the dialog in the way", async () => {
      transport.onCall('telemetry_status', () => atOldTerms());
      await render(signedIn);
      await act(async () => vi.advanceTimersByTime(3100));
      expect(document.querySelector('.sharing-prompt')).not.toBeNull();
    });
  });
});
