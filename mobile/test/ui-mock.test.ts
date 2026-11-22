import { beforeEach, describe, expect, it } from 'vitest';
import { createMock, mockQuestion, resetFleetState } from '../src/dev/mock';
import { useFleetState } from '../src/state/fleet';
import {
  emptyDraft,
  pickOption,
  sortSpaces,
  startableDevices,
  toWireAnswers,
} from '../src/ui/logic';

beforeEach(() => resetFleetState());

describe('mock services drive the store', () => {
  it('seeds a store every screen can render', () => {
    createMock();
    const s = useFleetState.getState();
    expect(s.connection).toBe('connected');
    expect(s.fingerprint).toMatch(/^([0-9a-f]{4} ){7}[0-9a-f]{4}$/);
    expect(s.spaces.length).toBeGreaterThan(2);
    expect(s.questions).toHaveLength(1);
    for (const d of s.devices) {
      expect(d.fingerprint).toMatch(/^([0-9a-f]{4} ){7}[0-9a-f]{4}$/);
    }
  });

  it('answers a question: wire shape, question cleared', async () => {
    const { services, calls } = createMock();
    const q = mockQuestion;
    const drafts = q.questions.map(emptyDraft);
    drafts[0] = pickOption(q.questions[0]!, drafts[0]!, 'vitest');
    drafts[1] = pickOption(q.questions[1]!, drafts[1]!, 'auth');
    await services.fleet.answer(q.space, q.askId, toWireAnswers(drafts));
    expect(calls.at(-1)).toEqual({
      method: 'answer',
      args: ['sp-waiting', 'ask-1', [['vitest'], ['auth']]],
    });
    const s = useFleetState.getState();
    expect(s.questions).toHaveLength(0);
    expect(s.spaces.find((x) => x.space === 'sp-waiting')?.question).toBeNull();
  });

  it('starts a space on a startable device and returns it', async () => {
    const { services } = createMock();
    const device = startableDevices(useFleetState.getState().devices)[0]!;
    const space = await services.fleet.startSpace({
      deviceId: device.deviceId,
      projectId: device.projects[0]!.id,
      goal: 'do it',
      mode: 'ask',
    });
    expect(space.hostName).toBe(device.name);
    expect(sortSpaces(useFleetState.getState().spaces)[0]?.space).toBe(
      'sp-waiting',
    );
    expect(
      useFleetState.getState().spaces.some((s) => s.space === space.space),
    ).toBe(true);
  });

  it('trusts the exact key and untrusts', async () => {
    const { services, calls } = createMock();
    await services.fleet.trust('dev-new', 'pk-new');
    expect(calls.at(-1)).toEqual({
      method: 'trust',
      args: ['dev-new', 'pk-new'],
    });
    const trusted = () =>
      useFleetState.getState().devices.find((d) => d.deviceId === 'dev-new')
        ?.trusted;
    expect(trusted()).toBe(true);
    await services.fleet.untrust('dev-new');
    expect(trusted()).toBe(false);
  });

  it('send needs idle/waiting in the UI; the mock marks the space running', async () => {
    const { services } = createMock();
    await services.fleet.send('sp-idle', 'next');
    const s = useFleetState.getState();
    expect(s.spaces.find((x) => x.space === 'sp-idle')?.status).toBe('running');
    expect(s.lines['sp-idle']?.at(-1)).toMatchObject({
      kind: 'turn',
      text: 'Turn 1: next',
    });
    // A mirrored space gets the row the host would mirror, under the id
    // the send's answer names.
    const row = Object.values(s.mirrors['sp-idle']!.messages).find(
      (m) => m.text === 'next',
    );
    expect(row).toMatchObject({ author: { kind: 'me' }, queued: null });
  });

  it('a failed org switch rejects and keeps the session', async () => {
    const { services, session } = createMock({
      failing: { switchOrganization: 'account: network error' },
    });
    await expect(
      services.auth.switchOrganization('org-acme'),
    ).rejects.toThrow();
    expect(session()?.organizationId).toBe('org-personal');
  });
});
