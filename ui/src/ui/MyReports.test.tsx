import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mount, type Mounted } from '../test/dom';
import { setTransport } from '../core/transport';
import { FakeTransport } from '../test/fakeTransport';
import { RootStore } from '../stores/RootStore';
import { RootStoreProvider } from '../stores/context';
import { EphemeralStore } from '../stores/EphemeralStore';
import type { TrackedReport } from '../gen/contract';
import { MyReports, reportStatus, sortReports } from './MyReports';

let m: Mounted | null = null;

beforeEach(() => {
  setTransport(new FakeTransport());
});

afterEach(() => {
  m?.unmount();
  m = null;
});

const report = (over: Partial<TrackedReport> = {}): TrackedReport => ({
  repo: 'acme/theodore',
  number: 42,
  url: 'https://github.com/acme/theodore/issues/42',
  title: 'Diff pane is blank',
  status: 'open',
  filed_at: 1_000,
  updated_at: Date.now() - 3 * 3600_000,
  comments: 0,
  ...over,
});

describe('reportStatus', () => {
  it('names the PR, the release, or why not', () => {
    expect(reportStatus(report()).label).toBe('Open');
    expect(reportStatus(report({ status: 'fixed', fixed_by: 57 })).label).toBe(
      'Fixed in #57',
    );
    expect(reportStatus(report({ status: 'fixed' })).label).toBe('Fixed');
    expect(
      reportStatus(report({ status: 'released', released_in: '0.1.7' })),
    ).toEqual({ label: 'Released in 0.1.7', color: 'success' });
    expect(
      reportStatus(report({ status: 'not_planned', close_reason: 'duplicate' }))
        .label,
    ).toBe('Duplicate');
    expect(reportStatus(report({ status: 'not_planned' })).label).toBe(
      'Not planned',
    );
  });

  it('lists the newest first', () => {
    const sorted = sortReports([
      report({ number: 1, filed_at: 1 }),
      report({ number: 2, filed_at: 2 }),
    ]);
    expect(sorted.map((r) => r.number)).toEqual([2, 1]);
  });
});

describe('MyReports', () => {
  it('is hidden without reports', async () => {
    const store = new RootStore();
    m = await mount(
      <RootStoreProvider store={store}>
        <MyReports />
      </RootStoreProvider>,
    );
    expect(m.host.querySelector('.my-reports')).toBeNull();
  });

  it('lists each report with its status and last activity', async () => {
    const store = new RootStore();
    store.sync.pool.put(
      'report',
      'acme/theodore#42',
      report({ status: 'fixed', fixed_by: 57, comments: 2 }),
    );
    m = await mount(
      <RootStoreProvider store={store}>
        <MyReports />
      </RootStoreProvider>,
    );
    const row = m.host.querySelector('.my-report');
    expect(row?.textContent).toContain('#42');
    expect(row?.textContent).toContain('Diff pane is blank');
    expect(row?.textContent).toContain('Fixed in #57');
    expect(row?.textContent).toContain('2 comments · 3h ago');
  });
});

describe('report_update', () => {
  it('becomes a toast that opens the issue', () => {
    const e = new EphemeralStore();
    e.handle({
      type: 'report_update',
      number: 42,
      url: 'https://github.com/acme/theodore/issues/42',
      title: 'Diff pane is blank',
      text: 'Your report #42 is fixed in #57',
    });
    expect(e.toasts).toHaveLength(1);
    expect(e.toasts[0]).toMatchObject({
      level: 'info',
      text: 'Your report #42 is fixed in #57',
    });
    expect(e.toasts[0]!.action?.label).toBe('Open');
  });
});
