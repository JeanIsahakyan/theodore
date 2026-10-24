/** "Report a problem": builds a local zip of redacted logs and app info,
 *  lists what's in it for review, and leaves sending it to the user.
 *
 *  open ─▶ api.reportProblem() ─▶ file list + zip path
 *                                   ├─▶ Reveal in Finder
 *                                   └─▶ Copy summary
 *
 *  The view uses only plain elements styled by HeroUI's CSS classes, so
 *  the error screen can show it even when the app's providers crashed. */
import { useEffect, useState } from 'react';
import type { ProblemReport } from '../gen/contract';
import { api, CommandFailure } from '../core/api';
import { useUi } from '../stores/context';
import { Shell } from './bits';

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

type State =
  | { phase: 'building' }
  | { phase: 'ready'; report: ProblemReport }
  | { phase: 'failed'; message: string };

export function PlainSpinner() {
  return (
    <span
      aria-hidden
      className="inline-block size-3 animate-spin rounded-full border-2 border-current border-t-transparent align-[-2px]"
    />
  );
}

export function ReportProblemView() {
  const [state, setState] = useState<State>({ phase: 'building' });
  const [copied, setCopied] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    api.reportProblem().then(
      (report) => live && setState({ phase: 'ready', report }),
      (e: unknown) =>
        live &&
        setState({
          phase: 'failed',
          message: e instanceof CommandFailure ? e.message : String(e),
        }),
    );
    return () => {
      live = false;
    };
  }, [attempt]);

  if (state.phase === 'building') {
    return (
      <div className="report-problem flex items-center gap-2 text-sm text-muted">
        <PlainSpinner /> Collecting logs…
      </div>
    );
  }
  if (state.phase === 'failed') {
    return (
      <div className="report-problem flex flex-col items-start gap-2 text-sm">
        <span className="text-danger">
          Couldn't build the report: {state.message}
        </span>
        <button
          type="button"
          className="button button--sm button--secondary"
          onClick={() => {
            setState({ phase: 'building' });
            setAttempt((a) => a + 1);
          }}
        >
          Try again
        </button>
      </div>
    );
  }
  const { report } = state;
  return (
    <div className="report-problem flex flex-col gap-3 text-sm">
      <span className="text-muted">
        Nothing is uploaded. Review the files, then attach the zip to an email
        or an issue yourself.
      </span>
      <ul className="report-files flex flex-col gap-1 rounded-xl bg-default/50 px-3 py-2">
        {report.files.map((f) => (
          <li key={f.name} className="flex items-center gap-3">
            <span className="min-w-0 flex-1 truncate font-mono text-xs">
              {f.name}
            </span>
            <span className="text-xs text-muted">{formatBytes(f.bytes)}</span>
          </li>
        ))}
      </ul>
      <span className="report-path break-all font-mono text-xs text-muted">
        {report.path}
      </span>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="report-reveal button button--sm button--primary"
          onClick={() => void api.revealReport(report.path).catch(() => {})}
        >
          Reveal in Finder
        </button>
        <button
          type="button"
          className="report-copy button button--sm button--secondary"
          onClick={() =>
            void navigator.clipboard
              .writeText(report.summary)
              .then(() => setCopied(true))
              .catch(() => {})
          }
        >
          {copied ? 'Copied' : 'Copy summary'}
        </button>
      </div>
    </div>
  );
}

export function ReportProblemModal() {
  const ui = useUi();
  return (
    <Shell title="Report a problem" onClose={() => ui.closeModal()}>
      <ReportProblemView />
    </Shell>
  );
}
