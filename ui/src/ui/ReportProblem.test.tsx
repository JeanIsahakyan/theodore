import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, mount, settle, typeInto, type Mounted } from '../test/dom';
import { setTransport } from '../core/transport';
import { FakeTransport } from '../test/fakeTransport';
import type { IssuePreview, IssueTarget } from '../gen/contract';
import { ReportProblemView } from './ReportProblem';

const signedIn: IssueTarget = {
  repo: 'acme/theodore',
  url: 'https://github.com/acme/theodore',
  login: 'octocat',
  unavailable: null,
};

const logs =
  '\n\n<details><summary>Logs (last 2 lines; 5 older lines cut)</summary>\n\n' +
  '```jsonl\n{"msg":"a"}\n{"msg":"b"}\n```\n\n</details>\n';

const preview: IssuePreview = {
  draft: 'd1',
  title: 'Blank pane',
  body: 'It is blank.\n\n| App info | |\n|---|---|\n| Version | 0.4.0 |' + logs,
  logs,
  log_lines: 2,
  cut_lines: 5,
};

let transport: FakeTransport;
let m: Mounted | null = null;

beforeEach(() => {
  transport = new FakeTransport();
  setTransport(transport);
});

afterEach(() => {
  m?.unmount();
  m = null;
  vi.restoreAllMocks();
});

const q = (sel: string) => m!.host.querySelector(sel);
const mode = (name: string) =>
  q(`.report-mode[data-mode="${name}"]`) as HTMLButtonElement;

async function open(target: IssueTarget): Promise<void> {
  transport.onCall('issue_target', () => target);
  m = await mount(<ReportProblemView />);
  await settle();
}

async function fill(title: string, comment: string): Promise<void> {
  await typeInto(q('.report-title'), title);
  await typeInto(q('.report-comment'), comment);
}

describe('ReportProblemView', () => {
  it('signed in, defaults to an issue with logs and says it is public', async () => {
    await open(signedIn);
    expect(mode('issue_with_logs').getAttribute('aria-checked')).toBe('true');
    expect(mode('issue').disabled).toBe(false);
    expect(q('.report-public')?.textContent).toContain(
      'Posted publicly as @octocat on github.com/acme/theodore',
    );
    expect(q('.report-send')?.textContent).toBe('Open issue');
  });

  it('without GitHub, only saving logs is offered, with the reason', async () => {
    await open({
      ...signedIn,
      login: null,
      unavailable: 'Sandbox mode never posts to GitHub.',
    });
    expect(mode('issue').disabled).toBe(true);
    expect(mode('issue_with_logs').disabled).toBe(true);
    expect(mode('logs_only').getAttribute('aria-checked')).toBe('true');
    expect(q('.report-unavailable')?.textContent).toBe(
      'Sandbox mode never posts to GitHub.',
    );
    expect(q('.report-title')).toBeNull();

    transport.onCall('report_problem', () => ({
      path: '/tmp/theodore-report.zip',
      dir: '/tmp/theodore-report',
      files: [{ name: 'app-info.json', bytes: 300 }],
      summary: 'Theodore 0.4.0',
    }));
    expect(q('.report-save')?.textContent).toBe('Save logs…');
    await click(q('.report-save'));
    await settle();
    expect(m!.host.textContent).toContain('app-info.json');
    expect(transport.calls.map((c) => c.cmd)).not.toContain('submit_issue');
  });

  it('needs a title and a comment before it can open the issue', async () => {
    await open(signedIn);
    const send = q('.report-send') as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    await typeInto(q('.report-title'), 'Blank pane');
    expect(send.disabled).toBe(true);
    await typeInto(q('.report-comment'), '   ');
    expect(send.disabled).toBe(true);
    await typeInto(q('.report-comment'), 'It is blank.');
    expect(send.disabled).toBe(false);
  });

  it('previews the exact body with the logs folded, then posts that draft', async () => {
    await open(signedIn);
    await fill('Blank pane', 'It is blank.');
    transport.onCall('preview_issue', () => preview);
    await click(q('.report-preview-toggle'));
    await settle();

    const req = transport.calls.find((c) => c.cmd === 'preview_issue')?.args
      ?.req as Record<string, unknown>;
    expect(req).toMatchObject({
      title: 'Blank pane',
      comment: 'It is blank.',
      with_logs: true,
      draft: null,
    });
    expect(q('.report-preview-body')?.textContent).toBe(
      'It is blank.\n\n| App info | |\n|---|---|\n| Version | 0.4.0 |',
    );
    const folded = q('.report-preview-logs') as HTMLDetailsElement;
    expect(folded.open).toBe(false);
    expect(folded.querySelector('summary')?.textContent).toBe(
      'Logs: 2 lines, 5 older cut to fit',
    );

    transport.onCall('submit_issue', () => ({
      number: 7,
      url: 'https://github.com/acme/theodore/issues/7',
    }));
    await click(q('.report-send'));
    await settle();
    const sent = transport.calls.find((c) => c.cmd === 'submit_issue')?.args
      ?.req as Record<string, unknown>;
    expect(sent).toMatchObject({ with_logs: true, draft: 'd1' });

    expect(q('.report-opened')?.textContent).toContain('Opened issue #7');
    const opened = vi.spyOn(window, 'open').mockImplementation(() => null);
    await click(q('.report-open'));
    expect(opened).toHaveBeenCalledWith(
      'https://github.com/acme/theodore/issues/7',
      '_blank',
    );
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    await click(q('.report-copy-link'));
    await settle();
    expect(writeText).toHaveBeenCalledWith(
      'https://github.com/acme/theodore/issues/7',
    );
    expect(q('.report-copy-link')?.textContent).toBe('Copied');
  });

  it('an issue without logs posts no logs', async () => {
    await open(signedIn);
    await click(mode('issue'));
    expect(q('.report-public')?.textContent).not.toContain('log');
    await fill('Blank pane', 'It is blank.');
    transport.onCall('submit_issue', () => ({ number: 8, url: 'u' }));
    await click(q('.report-send'));
    await settle();
    const sent = transport.calls.find((c) => c.cmd === 'submit_issue')?.args
      ?.req as Record<string, unknown>;
    expect(sent).toMatchObject({ with_logs: false, draft: null });
  });

  it('shows a failed post inline and keeps the text', async () => {
    await open(signedIn);
    await fill('Blank pane', 'It is blank.');
    transport.onCall('submit_issue', () => {
      throw {
        code: 'github_auth',
        message: 'GitHub sign-in expired or can’t open issues there.',
      };
    });
    await click(q('.report-send'));
    await settle();
    expect(q('.report-error')?.textContent).toBe(
      'GitHub sign-in expired or can’t open issues there.',
    );
    expect((q('.report-title') as HTMLInputElement).value).toBe('Blank pane');
    expect((q('.report-send') as HTMLButtonElement).disabled).toBe(false);
  });

  it('keeps what was typed when switching modes', async () => {
    await open(signedIn);
    await fill('Blank pane', 'It is blank.');
    await click(mode('logs_only'));
    expect(q('.report-title')).toBeNull();
    await click(mode('issue'));
    expect((q('.report-comment') as HTMLTextAreaElement).value).toBe(
      'It is blank.',
    );
  });
});
