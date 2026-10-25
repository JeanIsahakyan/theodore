import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, mount, settle, type Mounted } from '../test/dom';
import { setTransport } from '../core/transport';
import { FakeTransport } from '../test/fakeTransport';
import { ErrorBoundary } from './ErrorBoundary';

function Boom(): never {
  throw new Error('render failed');
}

let transport: FakeTransport;
let m: Mounted | null = null;

beforeEach(() => {
  transport = new FakeTransport();
  transport.onCall('log_client', () => null);
  setTransport(transport);
  // React reports the caught error to the console; keep the output clean.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  m?.unmount();
  m = null;
  vi.restoreAllMocks();
});

describe('ErrorBoundary', () => {
  it('shows the friendly screen and forwards the error once', async () => {
    m = await mount(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    await settle();
    expect(m.host.textContent).toContain('Something went wrong');
    expect(m.host.querySelector('.error-reload')?.textContent).toBe('Reload');
    const logs = transport.calls.filter((c) => c.cmd === 'log_client');
    expect(logs).toHaveLength(1);
    expect(logs[0]!.args?.entry).toMatchObject({
      source: 'boundary',
      message: 'Error: render failed',
    });
  });

  it('opens the report from the error screen', async () => {
    transport.onCall('report_problem', () => ({
      path: '/tmp/reports/theodore-report.zip',
      dir: '/tmp/reports/theodore-report',
      files: [{ name: 'app.log', bytes: 2048 }],
      summary: 'Theodore 1.0',
    }));
    transport.onCall('issue_target', () => ({
      repo: 'acme/theodore',
      url: 'https://github.com/acme/theodore',
      login: null,
      unavailable: 'Sign in to GitHub to open an issue.',
    }));
    m = await mount(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    await click(m.host.querySelector('.error-report'));
    await settle();
    await click(m.host.querySelector('.report-save'));
    await settle();
    expect(m.host.textContent).toContain('app.log');
    expect(m.host.textContent).toContain('2.0 KB');
    expect(m.host.textContent).toContain('/tmp/reports/theodore-report.zip');
    expect(m.host.textContent).toContain('Nothing is uploaded');
  });

  it('renders children when nothing fails', async () => {
    m = await mount(
      <ErrorBoundary>
        <span>fine</span>
      </ErrorBoundary>,
    );
    expect(m.host.textContent).toBe('fine');
  });
});
