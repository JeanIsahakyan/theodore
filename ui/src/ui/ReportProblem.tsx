/** "Report a problem": a public GitHub issue, with or without the redacted
 *  logs, or a local zip — one view, three modes.
 *
 *  open ─▶ api.issueTarget() ─▶ repo + @login, or why issues can't be posted
 *
 *  Open an issue ··········· title + comment + app info ──┐
 *  Open an issue with logs · + the newest redacted logs ──┼─▶ api.submitIssue ─▶ Open / Copy link
 *                    Preview ─▶ api.previewIssue: the exact body
 *  Save logs only ─▶ api.reportProblem ─▶ zip ─▶ Reveal in Finder / Copy summary
 *                                          (nothing uploaded)
 *
 *  A preview's draft id goes back with the post, so the app info and log
 *  lines sent are the ones the preview showed. The view uses only plain
 *  elements styled by HeroUI's CSS classes, so the error screen can show it
 *  even when the app's providers crashed. */
import { useEffect, useRef, useState } from 'react';
import type {
  IssuePreview,
  IssueTarget,
  ProblemReport,
  ReportedIssue,
  ReportMode,
} from '../gen/contract';
import { api, CommandFailure } from '../core/api';
import { openExternal } from '../core/openExternal';
import { useUi } from '../stores/context';
import { Shell } from './bits';

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function PlainSpinner() {
  return (
    <span
      aria-hidden
      className="inline-block size-3 animate-spin rounded-full border-2 border-current border-t-transparent align-[-2px]"
    />
  );
}

function message(e: unknown): string {
  return e instanceof CommandFailure ? e.message : String(e);
}

export const MODES: { mode: ReportMode; label: string }[] = [
  { mode: 'issue', label: 'Open an issue' },
  { mode: 'issue_with_logs', label: 'Open an issue with logs' },
  { mode: 'logs_only', label: 'Save logs only' },
];

/** GitHub's caps (the core checks them again). */
const MAX_TITLE = 256;
const MAX_COMMENT = 60_000;
/** Later previews wait for typing to pause; the first one doesn't. */
const PREVIEW_DELAY_MS = 300;

export function ReportProblemView() {
  const [target, setTarget] = useState<IssueTarget | null>(null);
  // `null` until the user picks: then the default follows the target.
  const [picked, setPicked] = useState<ReportMode | null>(null);
  const [title, setTitle] = useState('');
  const [comment, setComment] = useState('');

  useEffect(() => {
    let live = true;
    api.issueTarget().then(
      (t) => live && setTarget(t),
      (e: unknown) =>
        live &&
        setTarget({
          repo: '',
          url: '',
          login: null,
          unavailable: `Couldn't check GitHub: ${message(e)}`,
        }),
    );
    return () => {
      live = false;
    };
  }, []);

  if (!target) {
    return (
      <div className="report-problem flex items-center gap-2 text-sm text-muted">
        <PlainSpinner /> Checking GitHub…
      </div>
    );
  }
  const canPost = target.unavailable == null;
  const mode: ReportMode =
    picked ?? (canPost ? 'issue_with_logs' : 'logs_only');

  return (
    <div className="report-problem flex flex-col gap-3 text-sm">
      <div
        role="radiogroup"
        aria-label="How to report"
        className="report-modes toggle-button-group toggle-button-group--horizontal"
      >
        {MODES.map((m) => {
          const disabled = m.mode !== 'logs_only' && !canPost;
          return (
            <button
              key={m.mode}
              type="button"
              role="radio"
              aria-checked={mode === m.mode}
              data-selected={mode === m.mode}
              data-mode={m.mode}
              disabled={disabled}
              className="report-mode toggle-button"
              onClick={() => setPicked(m.mode)}
            >
              {m.label}
            </button>
          );
        })}
      </div>
      {!canPost && (
        <span className="report-unavailable text-xs text-muted">
          {target.unavailable}
        </span>
      )}
      {mode === 'logs_only' ? (
        <SaveLogs />
      ) : (
        <IssueForm
          target={target}
          withLogs={mode === 'issue_with_logs'}
          title={title}
          comment={comment}
          onTitle={setTitle}
          onComment={setComment}
        />
      )}
    </div>
  );
}

type Send =
  | { phase: 'editing' }
  | { phase: 'sending' }
  | { phase: 'failed'; message: string }
  | { phase: 'done'; issue: ReportedIssue };

function IssueForm({
  target,
  withLogs,
  title,
  comment,
  onTitle,
  onComment,
}: {
  target: IssueTarget;
  withLogs: boolean;
  title: string;
  comment: string;
  onTitle: (v: string) => void;
  onComment: (v: string) => void;
}) {
  const [send, setSend] = useState<Send>({ phase: 'editing' });
  const [showPreview, setShowPreview] = useState(false);
  const [preview, setPreview] = useState<IssuePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  // The core's draft: the app info and log lines the preview showed.
  const draft = useRef<string | null>(null);
  const previewed = useRef(false);
  const filled = title.trim() !== '' && comment.trim() !== '';

  useEffect(() => {
    if (!showPreview || !filled) return;
    let live = true;
    const timer = setTimeout(
      () =>
        api
          .previewIssue({
            title,
            comment,
            with_logs: withLogs,
            draft: draft.current,
          })
          .then(
            (p) => {
              if (!live) return;
              draft.current = p.draft;
              previewed.current = true;
              setPreview(p);
              setPreviewError(null);
            },
            (e: unknown) => live && setPreviewError(message(e)),
          ),
      previewed.current ? PREVIEW_DELAY_MS : 0,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [showPreview, filled, title, comment, withLogs]);

  if (send.phase === 'done') return <Opened issue={send.issue} />;

  const submit = () => {
    setSend({ phase: 'sending' });
    api
      .submitIssue({
        title,
        comment,
        with_logs: withLogs,
        draft: draft.current,
      })
      .then(
        (issue) => {
          setSend({ phase: 'done', issue });
          // Posted: coming back to this mode starts a new report.
          onTitle('');
          onComment('');
        },
        (e: unknown) => setSend({ phase: 'failed', message: message(e) }),
      );
  };
  const sending = send.phase === 'sending';
  // A preview from the other issue mode is stale until the next one lands.
  const shown = preview && (preview.logs != null) === withLogs ? preview : null;

  return (
    <div className="report-issue flex flex-col gap-3">
      <span className="report-public text-xs text-warning">
        Posted publicly as @{target.login} on github.com/{target.repo}
        {withLogs ? ', with the newest redacted log lines' : ''}. Anyone can
        read it.
      </span>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted">Title</span>
        <input
          className="report-title input input--full-width"
          value={title}
          maxLength={MAX_TITLE}
          placeholder="What went wrong, in one line"
          disabled={sending}
          onChange={(e) => onTitle(e.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted">Comment</span>
        <textarea
          className="report-comment textarea textarea--full-width"
          value={comment}
          rows={5}
          maxLength={MAX_COMMENT}
          placeholder="What you did, what you expected, what happened instead"
          disabled={sending}
          onChange={(e) => onComment(e.target.value)}
        />
      </label>
      <div className="flex flex-col gap-2">
        <button
          type="button"
          aria-expanded={showPreview}
          className="report-preview-toggle self-start text-xs text-muted underline-offset-2 hover:underline"
          onClick={() => setShowPreview((v) => !v)}
        >
          {showPreview ? '▾ Hide preview' : '▸ Preview'}
        </button>
        {showPreview && (
          <div className="report-preview flex flex-col gap-2 rounded-xl bg-default/50 px-3 py-2">
            {!filled ? (
              <span className="text-xs text-muted">
                Write a title and a comment to see the issue.
              </span>
            ) : previewError ? (
              <span className="text-xs text-danger">{previewError}</span>
            ) : !shown ? (
              <span className="flex items-center gap-2 text-xs text-muted">
                <PlainSpinner /> Building the preview…
              </span>
            ) : (
              <PreviewBody preview={shown} />
            )}
          </div>
        )}
      </div>
      {send.phase === 'failed' && (
        <span className="report-error text-xs text-danger">{send.message}</span>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="report-send button button--sm button--primary"
          disabled={!filled || sending}
          onClick={submit}
        >
          {sending ? (
            <>
              <PlainSpinner /> Opening…
            </>
          ) : (
            'Open issue'
          )}
        </button>
      </div>
    </div>
  );
}

/** The body as posted; the logs block folded. */
function PreviewBody({ preview }: { preview: IssuePreview }) {
  const head = preview.logs
    ? preview.body.slice(0, preview.body.length - preview.logs.length)
    : preview.body;
  return (
    <>
      <span className="report-preview-title font-medium">{preview.title}</span>
      <pre className="report-preview-body whitespace-pre-wrap break-words font-mono text-xs">
        {head}
      </pre>
      {preview.logs != null && (
        <details className="report-preview-logs text-xs">
          <summary className="cursor-pointer text-muted">
            Logs: {preview.log_lines} lines
            {preview.cut_lines > 0
              ? `, ${preview.cut_lines} older cut to fit`
              : ''}
          </summary>
          <pre className="mt-1 max-h-64 overflow-auto whitespace-pre font-mono">
            {preview.logs.trim()}
          </pre>
        </details>
      )}
    </>
  );
}

function Opened({ issue }: { issue: ReportedIssue }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="report-opened flex flex-col gap-2">
      <span>Opened issue #{issue.number}. Thank you.</span>
      <span className="report-link break-all font-mono text-xs text-muted">
        {issue.url}
      </span>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="report-open button button--sm button--primary"
          onClick={() => openExternal(issue.url)}
        >
          Open
        </button>
        <button
          type="button"
          className="report-copy-link button button--sm button--secondary"
          onClick={() =>
            void navigator.clipboard
              .writeText(issue.url)
              .then(() => setCopied(true))
              .catch(() => {})
          }
        >
          {copied ? 'Copied' : 'Copy link'}
        </button>
      </div>
    </div>
  );
}

type Zip =
  | { phase: 'idle' }
  | { phase: 'building' }
  | { phase: 'ready'; report: ProblemReport }
  | { phase: 'failed'; message: string };

function SaveLogs() {
  const [zip, setZip] = useState<Zip>({ phase: 'idle' });
  const [copied, setCopied] = useState(false);

  const build = () => {
    setZip({ phase: 'building' });
    api.reportProblem().then(
      (report) => setZip({ phase: 'ready', report }),
      (e: unknown) => setZip({ phase: 'failed', message: message(e) }),
    );
  };

  if (zip.phase === 'idle' || zip.phase === 'failed') {
    return (
      <div className="flex flex-col items-start gap-2">
        <span className="text-muted">
          Nothing is uploaded. Builds a zip of the redacted logs and app info to
          attach to an email or an issue yourself.
        </span>
        {zip.phase === 'failed' && (
          <span className="text-danger">
            Couldn't build the report: {zip.message}
          </span>
        )}
        <button
          type="button"
          className="report-save button button--sm button--primary"
          onClick={build}
        >
          {zip.phase === 'failed' ? 'Try again' : 'Save logs…'}
        </button>
      </div>
    );
  }
  if (zip.phase === 'building') {
    return (
      <div className="flex items-center gap-2 text-muted">
        <PlainSpinner /> Collecting logs…
      </div>
    );
  }
  const { report } = zip;
  return (
    <div className="flex flex-col gap-3">
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
