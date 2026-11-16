import { describe, expect, it } from 'vitest';
import { mockAgents, mockDevices } from '../src/dev/mock';
import type { FleetDeviceView } from '../src/fleet/types';
import { NO_PICK, pickEffort, spaceOwn } from '../src/ui/agents';
import {
  NO_DRAFT,
  addRecent,
  chooseWhere,
  cleanPick,
  deviceRows,
  recentChips,
  resolveHome,
  shorten,
  whereLabel,
} from '../src/ui/homeDraft';
import { startableDevices } from '../src/ui/logic';
import {
  chooseModel,
  closesAfter,
  effortView,
  hasPick,
  modelSections,
  offersChoice,
} from '../src/ui/modelPicker';

const agents = mockAgents;
const startable = startableDevices(mockDevices);
const mac = startable.find((d) => d.deviceId === 'dev-mac')!;

describe('model sheet rows', () => {
  it("a heading per agent when there are several, ✓ on what runs, 'Default' or the agent", () => {
    const s = modelSections(agents, NO_PICK);
    expect(s.map((x) => x.title)).toEqual(['Claude', 'Codex']);
    const claude = s[0]!.rows;
    expect(claude.map((r) => [r.label, r.subtitle, r.selected])).toEqual([
      ['Opus 4.1', 'Default', true],
      ['Sonnet 4.5', 'Claude', false],
      ['Haiku 4.5', 'Claude', false],
    ]);
    expect(claude[0]!.accessibilityLabel).toBe('Opus 4.1, Claude, default');
    expect(s[1]!.rows[0]!.selected).toBe(false);
  });

  it('one agent: no heading; an agent with no models is one row', () => {
    const solo = [{ ...agents[1]!, models: [] }];
    const s = modelSections(solo, NO_PICK);
    expect(s[0]!.title).toBeNull();
    expect(s[0]!.rows).toEqual([
      expect.objectContaining({ model: null, label: 'Codex', selected: true }),
    ]);
  });

  it("a space's own model is checked while nothing is picked", () => {
    const own = spaceOwn({ agent: 'claude', model: 'sonnet', effort: 'low' });
    const rows = modelSections(agents, NO_PICK, own)[0]!.rows;
    expect(rows.find((r) => r.selected)?.model).toBe('claude-sonnet-4-5');
  });
});

describe('a model tapped', () => {
  it('same agent: the model changes, an effort it takes stays', () => {
    const p = chooseModel(
      agents,
      pickEffort(NO_PICK, 'max'),
      NO_PICK,
      'claude',
      'claude-sonnet-4-5',
    );
    expect(p).toEqual({
      agent: null,
      model: 'claude-sonnet-4-5',
      effort: 'max',
    });
    expect(closesAfter(agents, p)).toBe(false);
  });

  it('a model with no effort: the effort is dropped and the sheet closes', () => {
    const p = chooseModel(
      agents,
      pickEffort(NO_PICK, 'max'),
      NO_PICK,
      'claude',
      'claude-haiku-4-5',
    );
    expect(p.effort).toBeNull();
    expect(closesAfter(agents, p)).toBe(true);
  });

  it('another agent: it and the model named, the effort from its defaults', () => {
    const p = chooseModel(
      agents,
      pickEffort(NO_PICK, 'max'),
      NO_PICK,
      'codex',
      'gpt-5-codex',
    );
    expect(p).toEqual({ agent: 'codex', model: 'gpt-5-codex', effort: null });
    // An agent the host doesn't list: nothing changes.
    expect(chooseModel(agents, p, NO_PICK, 'gemini', 'x')).toBe(p);
  });
});

describe('effort', () => {
  it('the levels as short segments, read in full; Default names what runs', () => {
    const e = effortView(agents, NO_PICK);
    expect(e.value).toBeNull();
    expect(e.defaultLabel).toBe('Default (High)');
    expect(e.choices.map((c) => c.label)).toEqual([
      'Low',
      'Med',
      'High',
      'XHigh',
      'Max',
      'Ultra',
    ]);
    expect(e.choices.at(-1)!.accessibilityLabel).toBe('Ultracode');
    const picked = effortView(agents, pickEffort(NO_PICK, 'low'));
    expect(picked.value).toBe('low');
    expect(picked.defaultLabel).toBe('Default (High)');
  });

  it("a space's own effort is its default", () => {
    const own = spaceOwn({ agent: 'claude', model: null, effort: 'max' });
    expect(effortView(agents, NO_PICK, own).defaultLabel).toBe('Default (Max)');
  });

  it('a model that takes none: no effort section', () => {
    const e = effortView(agents, { ...NO_PICK, model: 'claude-haiku-4-5' });
    expect(e.choices).toEqual([]);
  });

  it('Reset has something to do only once something is picked', () => {
    expect(hasPick(NO_PICK)).toBe(false);
    expect(hasPick(pickEffort(NO_PICK, 'low'))).toBe(true);
  });

  it('the chip shows only when there is a choice', () => {
    expect(offersChoice(agents)).toBe(true);
    expect(offersChoice([])).toBe(false);
    const one = {
      ...agents[1]!,
      models: [{ ...agents[1]!.models[0]!, efforts: [] }],
    };
    expect(offersChoice([one])).toBe(false);
  });
});

describe("Home's draft against the devices listed now", () => {
  it('nothing picked: the first device and its first project, Edit', () => {
    const r = resolveHome(startable, NO_DRAFT);
    expect(r.device?.deviceId).toBe('dev-mac');
    expect(r.project?.id).toBe('p-theodore');
    expect(r.mode).toBe('edit');
    expect(r.pick).toEqual(NO_PICK);
  });

  it('restores what is still valid', () => {
    const draft = {
      deviceId: 'dev-mac',
      projectId: 'p-tama',
      mode: 'plan' as const,
      pick: { agent: 'claude', model: 'claude-sonnet-4-5', effort: 'max' },
    };
    const r = resolveHome(startable, draft);
    expect(r.device?.deviceId).toBe('dev-mac');
    expect(r.project?.id).toBe('p-tama');
    expect(r.mode).toBe('plan');
    expect(r.pick).toEqual(draft.pick);
  });

  it('a device gone: the first, and the pick made for the other dropped', () => {
    const r = resolveHome(startable, {
      deviceId: 'dev-work',
      projectId: 'p-web',
      mode: 'run',
      pick: { agent: 'claude', model: null, effort: null },
    });
    expect(r.device?.deviceId).toBe('dev-mac');
    expect(r.project?.id).toBe('p-theodore');
    // Capped by mac's Edit.
    expect(r.mode).toBe('edit');
    expect(r.pick).toEqual(NO_PICK);
  });

  it('a project gone: the first of the device', () => {
    const r = resolveHome(startable, {
      ...NO_DRAFT,
      deviceId: 'dev-mac',
      projectId: 'p-gone',
    });
    expect(r.project?.id).toBe('p-theodore');
  });

  it('parts of the pick no longer listed are dropped', () => {
    expect(
      cleanPick(agents, { agent: 'gemini', model: 'x', effort: 'low' }),
    ).toEqual(NO_PICK);
    expect(
      cleanPick(agents, {
        agent: 'claude',
        model: 'claude-old',
        effort: 'max',
      }),
    ).toEqual({ agent: 'claude', model: null, effort: 'max' });
    expect(
      cleanPick(agents, {
        agent: 'claude',
        model: 'claude-haiku-4-5',
        effort: 'max',
      }),
    ).toEqual({ agent: 'claude', model: 'claude-haiku-4-5', effort: null });
    // A host that lists none (older): nothing.
    expect(
      cleanPick([], { agent: 'claude', model: null, effort: null }),
    ).toEqual(NO_PICK);
  });

  it('no computer can take one: nothing', () => {
    expect(resolveHome([], NO_DRAFT).device).toBeNull();
  });

  it('another device drops the agent pick and caps the mode', () => {
    const d = { ...NO_DRAFT, deviceId: 'dev-box', mode: 'run' as const };
    const onMac = chooseWhere(
      { ...d, pick: { agent: 'claude', model: null, effort: null } },
      mac,
      'p-tama',
    );
    expect(onMac).toEqual({
      deviceId: 'dev-mac',
      projectId: 'p-tama',
      mode: 'edit',
      pick: NO_PICK,
    });
    const pick = { agent: 'claude', model: null, effort: 'low' };
    expect(chooseWhere({ ...onMac, pick }, mac, 'p-theodore').pick).toEqual(
      pick,
    );
  });
});

describe('recent projects', () => {
  it('newest first, no duplicates, at most five', () => {
    let r = addRecent([], 'dev-mac', 'p-theodore');
    r = addRecent(r, 'dev-box', 'p-api');
    r = addRecent(r, 'dev-mac', 'p-theodore');
    expect(r).toEqual([
      { deviceId: 'dev-mac', projectId: 'p-theodore' },
      { deviceId: 'dev-box', projectId: 'p-api' },
    ]);
    for (let i = 0; i < 9; i++) r = addRecent(r, 'dev-x', `p-${i}`);
    expect(r).toHaveLength(5);
  });

  it('chips: still startable, not the one shown, at most three', () => {
    const recent = [
      { deviceId: 'dev-mac', projectId: 'p-theodore' },
      { deviceId: 'dev-work', projectId: 'p-web' },
      { deviceId: 'dev-box', projectId: 'p-api' },
      { deviceId: 'dev-mac', projectId: 'p-gone' },
      { deviceId: 'dev-mac', projectId: 'p-tama' },
    ];
    const chips = recentChips(recent, startable, {
      deviceId: 'dev-mac',
      projectId: 'p-theodore',
    });
    expect(chips.map((c) => c.label)).toEqual([
      'api · build-box',
      'tamagochi · MacBook Pro',
    ]);
    expect(chips[0]!.accessibilityLabel).toBe('Use api on build-box');
  });
});

describe('where', () => {
  it('chip text short, read in full', () => {
    expect(shorten('abcdef', 4)).toBe('abc…');
    expect(
      whereLabel({ name: 'Jean’s MacBook Pro 16' }, { name: 'theodore' }),
    ).toEqual({
      label: 'Jean’s MacBoo… · theodore',
      accessibilityLabel: 'Runs on Jean’s MacBook Pro 16, project theodore',
    });
  });

  it('devices you trust, those that take a space first, the others say why not', () => {
    const offline: FleetDeviceView = {
      ...mac,
      deviceId: 'dev-off',
      name: 'Attic',
      online: false,
    };
    const closed: FleetDeviceView = {
      ...mac,
      deviceId: 'dev-closed',
      name: 'Basement',
      acceptsRemote: false,
    };
    const all = [...mockDevices, offline, closed];
    const rows = deviceRows(all, startableDevices(all));
    expect(rows.map((r) => [r.device.name, r.enabled, r.detail])).toEqual([
      ['build-box', true, '1 project · up to Run'],
      ['MacBook Pro', true, '2 projects · up to Edit'],
      ['Basement', false, "Doesn't take spaces from other devices"],
      ['Attic', false, 'Offline'],
    ]);
  });
});
