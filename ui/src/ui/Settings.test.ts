import { beforeEach, describe, expect, it } from 'vitest';
import { setTransport } from '../core/transport';
import { FakeTransport } from '../test/fakeTransport';
import { modelAccessors } from '../sync';
import { SyncClient } from '../sync/SyncClient';
import { EphemeralStore } from '../stores/EphemeralStore';
import type { RootStore } from '../stores/RootStore';
import { setSetting } from '../actions';
import { isAgentEnabled, isUserMcpAllowed, USER_MCP_KEY } from './Settings';

/** Same fake wiring as `actions.test.ts` — only `sync`/`models` are read by
 *  `isAgentEnabled`/`setSetting`. */
function fakeStore(): RootStore {
  const sync = new SyncClient();
  const ephemeral = new EphemeralStore();
  const models = modelAccessors(sync.pool);
  return { sync, ephemeral, models } as unknown as RootStore;
}

let transport: FakeTransport;

beforeEach(() => {
  transport = new FakeTransport();
  setTransport(transport);
  transport.onCall('transact', () => ({ status: 'ok', last_sync_id: 1 }));
});

describe('isAgentEnabled', () => {
  it('defaults to enabled when no setting exists', () => {
    const store = fakeStore();
    expect(isAgentEnabled(store, 'claude')).toBe(true);
  });

  it('is disabled once agents.<id>.enabled is set to false', () => {
    const store = fakeStore();
    setSetting(store, 'user', 'agents.claude.enabled', false);
    expect(isAgentEnabled(store, 'claude')).toBe(false);
  });

  it('is enabled again once set back to true', () => {
    const store = fakeStore();
    setSetting(store, 'user', 'agents.claude.enabled', false);
    setSetting(store, 'user', 'agents.claude.enabled', true);
    expect(isAgentEnabled(store, 'claude')).toBe(true);
  });

  it('tracks agents independently', () => {
    const store = fakeStore();
    setSetting(store, 'user', 'agents.claude.enabled', false);
    expect(isAgentEnabled(store, 'codex')).toBe(true);
  });
});

describe('isUserMcpAllowed', () => {
  it('defaults to allowed when no setting exists', () => {
    expect(isUserMcpAllowed(fakeStore())).toBe(true);
  });

  it('is off once agents.user_mcp is set to false, on again with true', () => {
    const store = fakeStore();
    setSetting(store, 'user', USER_MCP_KEY, false);
    expect(isUserMcpAllowed(store)).toBe(false);
    setSetting(store, 'user', USER_MCP_KEY, true);
    expect(isUserMcpAllowed(store)).toBe(true);
  });

  it('ignores a repo-scoped value', () => {
    const store = fakeStore();
    setSetting(store, 'repo:acme/app', USER_MCP_KEY, false);
    expect(isUserMcpAllowed(store)).toBe(true);
  });
});
