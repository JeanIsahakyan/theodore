import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeTransport } from '../test/fakeTransport';
import {
  api,
  CommandFailure,
  setAccountRequiredHandler,
  setCommandFailureHandler,
} from './api';
import { setTransport } from './transport';

describe('a command turned away by the account gate', () => {
  let transport: FakeTransport;
  const toast = vi.fn();
  const recheck = vi.fn();

  beforeEach(() => {
    transport = new FakeTransport();
    setTransport(transport);
    setCommandFailureHandler(toast);
    setAccountRequiredHandler(recheck);
  });

  afterEach(() => {
    toast.mockReset();
    recheck.mockReset();
  });

  it('re-reads the account instead of toasting', async () => {
    transport.onCall('open_pr', () => {
      throw { code: 'account_required', message: 'Sign in' };
    });
    const err = await api
      .openPr({ url: 'https://github.com/a/b/pull/1' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommandFailure);
    expect((err as CommandFailure).code).toBe('account_required');
    expect(recheck).toHaveBeenCalledTimes(1);
    expect(toast).not.toHaveBeenCalled();
  });

  it('leaves other failures to the toast', async () => {
    transport.onCall('open_pr', () => {
      throw { code: 'host', message: 'offline' };
    });
    await api.openPr({ url: 'https://github.com/a/b/pull/1' }).catch(() => {});
    expect(toast).toHaveBeenCalledTimes(1);
    expect(recheck).not.toHaveBeenCalled();
  });
});
