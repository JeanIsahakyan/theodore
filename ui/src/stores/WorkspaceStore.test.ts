import { beforeEach, describe, expect, it } from 'vitest';
import type { PrSummary, Project, RepoRef, Task } from '../gen/contract';
import { ALL } from '../core/workspaces';
import { ObjectPool } from '../sync/ObjectPool';
import { modelAccessors } from '../sync';
import { UiStore } from './UiStore';
import { WorkspaceStore } from './WorkspaceStore';

const repo = (name: string): RepoRef => ({
  host: 'github',
  owner: 'acme',
  name,
});

const project = (name: string, added_at = 0): Project => ({
  id: `github:acme/${name}`,
  repo: repo(name),
  path: null,
  status: 'ready',
  error: null,
  default_branch: 'main',
  added_at,
});

const summary = (name: string, n: number): PrSummary => ({
  pr: { repo: repo(name), number: n, host_id: null },
  title: 't',
  author: { login: 'me', name: null, avatar_url: null },
  state: 'open',
  base_ref: 'main',
  head_ref: 'f',
  head_sha: 'abc',
  additions: 0,
  deletions: 0,
  changed_files: 0,
  reasons: ['review_requested'],
  checks: 'none',
  approvals: 0,
  required_approvals: null,
  updated_at: 0,
  url: '',
});

const task = (id: string, pr: string): Omit<Task, 'id'> & { id: string } =>
  ({ id, pr }) as Task;

function setup() {
  const pool = new ObjectPool();
  const models = modelAccessors(pool);
  const ui = new UiStore();
  const ws = new WorkspaceStore(models, ui);
  const web = project('web', 1);
  const api = project('api', 2);
  pool.put('project', web.id, web);
  pool.put('project', api.id, api);
  pool.put('pr', 'github:acme/web#1', summary('web', 1));
  pool.put('pr', 'github:acme/api#1', summary('api', 1));
  pool.put('pr', 'github:else/x#1', {
    ...summary('x', 1),
    pr: { repo: { host: 'github', owner: 'else', name: 'x' }, number: 1 },
  });
  return { pool, models, ui, ws, web, api };
}

beforeEach(() => localStorage.clear());

describe('WorkspaceStore scoping', () => {
  it('shows every PR and task under All', () => {
    const { ws, models } = setup();
    expect(ws.scopePrs(models.prSummaries.all())).toHaveLength(3);
    expect(
      ws.scopeTasks([task('t1', 'github:acme/web#1'), task('t2', 'x')]),
    ).toHaveLength(2);
  });

  it('filters PRs and tasks to the active project by repo', () => {
    const { ws, models, web } = setup();
    ws.switchTo(web.id);
    expect(ws.scopePrs(models.prSummaries.all()).map((p) => p.id)).toEqual([
      'github:acme/web#1',
    ]);
    // A task's PR summary may not be loaded: its repo comes off the PR id.
    expect(
      ws
        .scopeTasks([
          task('t1', 'github:acme/web#1'),
          task('t2', 'github:acme/web#9'),
          task('t3', 'github:acme/api#1'),
        ])
        .map((t) => t.id),
    ).toEqual(['t1', 't2']);
  });

  it('counts badges per workspace', () => {
    const { ws, web, api } = setup();
    expect(ws.badges.get(ALL)).toBe(3);
    expect(ws.badges.get(web.id)).toBe(1);
    expect(ws.badges.get(api.id)).toBe(1);
  });
});

describe('WorkspaceStore navigation', () => {
  it('opens another project’s PR in its own workspace', () => {
    const { ws, ui, web, api } = setup();
    ws.switchTo(web.id);
    ui.go({ name: 'review', pr: 'github:acme/api#1' });
    expect(ui.workspace).toBe(api.id);
    expect(ui.route).toEqual({ name: 'review', pr: 'github:acme/api#1' });
  });

  it('switches to the workspace that already has the PR open', () => {
    const { ws, ui, web } = setup();
    ui.go({ name: 'review', pr: 'github:acme/web#1' }); // opened under All
    ws.switchTo(web.id);
    ui.go({ name: 'review', pr: 'github:acme/web#1' });
    expect(ui.workspace).toBe(ALL);
    expect(
      ui.tabs.filter(
        (t) => t.name === 'review' && t.pr === 'github:acme/web#1',
      ),
    ).toHaveLength(1);
  });

  it('switches with ⌃N in switcher order and ⌃0 back to All', () => {
    const { ws, ui, web, api } = setup();
    const key = (code: string) =>
      new KeyboardEvent('keydown', { code, ctrlKey: true });
    expect(ws.switchForKey(key('Digit2'))).toBe(true);
    expect(ui.workspace).toBe(api.id);
    ws.reorder([api.id], web.id, 'before');
    expect(ws.projects.map((p) => p.id)).toEqual([api.id, web.id]);
    ws.switchForKey(key('Digit2'));
    expect(ui.workspace).toBe(web.id);
    ws.switchForKey(key('Digit0'));
    expect(ui.workspace).toBe(ALL);
    expect(ws.switchForKey(key('Digit5'))).toBe(false);
  });

  it('keeps the dragged order across a relaunch', () => {
    const { ws, web, api, models } = setup();
    ws.reorder([api.id], web.id, 'before');
    const again = new WorkspaceStore(models, new UiStore());
    expect(again.projects.map((p) => p.id)).toEqual([api.id, web.id]);
  });

  it('forgets a removed project', () => {
    const { ws, ui, web, api } = setup();
    ws.reorder([api.id], web.id, 'before');
    ws.switchTo(api.id);
    ws.forget(api.id);
    expect(ui.workspace).toBe(ALL);
    expect(ws.order).toEqual([web.id]);
  });
});
