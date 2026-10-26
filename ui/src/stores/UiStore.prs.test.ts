import { beforeEach, describe, expect, it } from 'vitest';
import { ALL } from '../core/workspaces';
import { UiStore, loadSnapshot, wsKey, type Route } from './UiStore';

const WEB = 'github:acme/web';
const LOCAL = 'local:core.loc';
const review = (pr: string): Route => ({ name: 'review', pr });

beforeEach(() => localStorage.clear());

describe('Pull requests filter', () => {
  it('is saved per workspace and restored on a switch', () => {
    const ui = new UiStore();
    expect(ui.prsFilter).toBe('all');
    ui.setPrsFilter('merged');
    ui.switchWorkspace(WEB);
    expect(ui.prsFilter).toBe('all');
    ui.setPrsFilter('drafts');
    ui.switchWorkspace(ALL);
    expect(ui.prsFilter).toBe('merged');
    ui.switchWorkspace(WEB);
    expect(ui.prsFilter).toBe('drafts');
  });

  it('survives a relaunch', () => {
    const ui = new UiStore();
    ui.goPrs('mine');
    expect(loadSnapshot(ALL)?.prsFilter).toBe('mine');
    const next = new UiStore();
    expect(next.route).toEqual({ name: 'prs' });
    expect(next.prsFilter).toBe('mine');
  });

  it('opens Pull requests with the filter asked for', () => {
    const ui = new UiStore();
    ui.goPrs('drafts');
    expect(ui.route).toEqual({ name: 'prs' });
    expect(ui.prsFilter).toBe('drafts');
    ui.goPrs();
    expect(ui.prsFilter).toBe('drafts');
  });

  it('leaves the filter alone when the page lands elsewhere', () => {
    const ui = new UiStore();
    ui.place = (route) => ({
      ws: ui.workspace,
      route: route.name === 'prs' ? { name: 'branches' } : route,
    });
    ui.goPrs('mine');
    expect(ui.route).toEqual({ name: 'branches' });
    expect(ui.prsFilter).toBe('all');
  });

  it('falls back to All for a filter it does not know', () => {
    localStorage.setItem(
      wsKey(ALL),
      JSON.stringify({
        tabs: [{ name: 'prs' }],
        route: { name: 'prs' },
        prsFilter: 'nope',
      }),
    );
    expect(loadSnapshot(ALL)?.prsFilter).toBe('all');
  });
});

describe('a local-folder workspace', () => {
  it('opens on Branches', () => {
    const ui = new UiStore();
    ui.switchWorkspace(LOCAL);
    expect(ui.tabs).toEqual([{ name: 'branches' }]);
    expect(ui.route).toEqual({ name: 'branches' });
  });

  it('lands on Branches once its last tab closes', () => {
    const ui = new UiStore();
    ui.switchWorkspace(LOCAL);
    ui.go({ name: 'tasks' });
    ui.closeTab({ name: 'tasks' });
    expect(ui.route).toEqual({ name: 'branches' });
  });
});

describe('migration of saved snapshots', () => {
  const save = (ws: string, v: unknown) =>
    localStorage.setItem(wsKey(ws), JSON.stringify(v));

  it("turns a project's Overview tab into its Pull requests", () => {
    save(WEB, {
      tabs: [{ name: 'project', id: WEB }, review(`${WEB}#1`)],
      route: { name: 'project', id: WEB },
      back: { name: 'project', id: WEB },
    });
    const s = loadSnapshot(WEB)!;
    expect(s.tabs).toEqual([{ name: 'prs' }, review(`${WEB}#1`)]);
    expect(s.route).toEqual({ name: 'prs' });
    expect(s.back).toEqual({ name: 'prs' });
  });

  it("turns a local folder's Overview tab into its Branches", () => {
    save(LOCAL, {
      tabs: [{ name: 'project', id: LOCAL }],
      route: { name: 'project', id: LOCAL },
    });
    const s = loadSnapshot(LOCAL)!;
    expect(s.tabs).toEqual([{ name: 'branches' }]);
    expect(s.route).toEqual({ name: 'branches' });
  });

  it('turns My PRs into Pull requests with the Mine filter', () => {
    save(ALL, {
      tabs: [{ name: 'inbox' }, { name: 'mine' }],
      route: { name: 'mine' },
    });
    const s = loadSnapshot(ALL)!;
    expect(s.tabs).toEqual([{ name: 'inbox' }, { name: 'prs' }]);
    expect(s.route).toEqual({ name: 'prs' });
    expect(s.prsFilter).toBe('mine');
  });

  it('merges tabs that became the same page', () => {
    save(WEB, {
      tabs: [{ name: 'project', id: WEB }, { name: 'mine' }],
      route: { name: 'mine' },
    });
    const s = loadSnapshot(WEB)!;
    expect(s.tabs).toEqual([{ name: 'prs' }]);
    expect(s.prsFilter).toBe('mine');
  });

  it('drops tabs it cannot read and keeps the rest', () => {
    save(ALL, {
      tabs: [{ name: 'gone' }, { name: 'tasks' }],
      route: { name: 'gone' },
    });
    const s = loadSnapshot(ALL)!;
    expect(s.tabs).toEqual([{ name: 'tasks' }]);
    expect(s.route).toEqual({ name: 'tasks' });
  });

  it('starts a workspace fresh when no saved tab is readable', () => {
    save(ALL, { tabs: [{ name: 'gone' }], route: { name: 'gone' } });
    expect(loadSnapshot(ALL)).toBeNull();
    const ui = new UiStore();
    expect(ui.tabs).toEqual([{ name: 'inbox' }]);
  });

  it('restores an old snapshot on launch without crashing', () => {
    save(WEB, {
      tabs: [{ name: 'project', id: WEB }, { name: 'mine' }],
      route: { name: 'project', id: WEB },
    });
    localStorage.setItem('theodore-workspace', WEB);
    const ui = new UiStore();
    expect(ui.workspace).toBe(WEB);
    expect(ui.route).toEqual({ name: 'prs' });
    expect(ui.prsFilter).toBe('mine');
  });
});
