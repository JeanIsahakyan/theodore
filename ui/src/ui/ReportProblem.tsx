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
 *  even when the app's providers crashed.
 *
 *  From a chat ("Report this", `/report`, an agent's `report_problem`) the
 *  view opens on a `ReportDraft`: title and comment prefilled, and the
 *  conversation (`context: draft.id`) and that run's logs go with it unless
 *  unticked. The preview shows both, folded, before anything is posted.
 *
 *  Files (📎, paste, drop) are never posted: GitHub has no API for issue
 *  attachments. After the issue opens, "Show files and open the issue"
 *  copies them into one folder (`stage_report_files`), shows it in Finder
 *  and opens the issue, for the user to drop them into a comment. */
import { useEffect, useRef, useState } from 'react';
import { observer } from 'mobx-react-lite';
import type {
  Attachment,
  IssuePreview,
  IssueTarget,
  ProblemReport,
  ReportDraft,
  ReportedIssue,
  ReportMode,
} from '../gen/contract';
import { api, CommandFailure } from '../core/api';
import { openExternal } from '../core/openExternal';
import { useUi } from '../stores/context';
import { fileHandlers, useAttachments, type Attachments } from './attachments';
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

/** A mode's label; from a chat the logs are that run's. */
function modeLabel(m: ReportMode, chat: boolean): string {
  if (chat && m === 'issue_with_logs')
    return "Open an issue with this run's logs";
  return MODES.find((x) => x.mode === m)?.label ?? m;
}

export function ReportProblemView({
  draft = null,
}: {
  /** A chat report to open on; none: the plain report. */
  draft?: ReportDraft | null;
}) {
  const [target, setTarget] = useState<IssueTarget | null>(null);
  // `null` until the user picks: then the default follows the target.
  const [picked, setPicked] = useState<ReportMode | null>(null);
  const [title, setTitle] = useState(draft?.title ?? '');
  const [comment, setComment] = useState(draft?.description ?? '');
  // The conversation goes with a chat report unless you untick it.
  const [withChat, setWithChat] = useState(true);
  const chat = draft && withChat ? draft : null;
  // Kept across mode switches, like the text.
  const files = useAttachments();

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
    picked ??
    (!canPost
      ? 'logs_only'
      : draft && !draft.include_logs
        ? 'issue'
        : 'issue_with_logs');

  return (
    <div className="report-problem flex flex-col gap-3 text-sm">
      {draft && (
        <div className="report-about flex flex-col gap-1 rounded-xl bg-default/50 px-3 py-2">
          <span className="text-xs">
            <span className="text-muted">About: </span>
            <span className="report-about-line">{draft.about}</span>
            {draft.by_agent && (
              <span className="report-by-agent text-muted">
                {' '}
                · drafted by the agent: check it before sending
              </span>
            )}
          </span>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              className="report-with-chat"
              checked={withChat}
              onChange={(e) => setWithChat(e.target.checked)}
            />
            Include the conversation: prompt, reply, tool calls, error
          </label>
        </div>
      )}
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
              {modeLabel(m.mode, chat != null)}
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
          context={chat?.id ?? null}
          title={title}
          comment={comment}
          files={files}
          onTitle={setTitle}
          onComment={setComment}
        />
      )}
    </div>
  );
}

/** 📎, a paste or a drop, as in a chat; the files stay on this Mac until
 *  the user adds them to the issue on GitHub (no API takes them). */
function ReportFiles({
  files,
  disabled,
}: {
  files: Attachments;
  disabled: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="report-files-box flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label="Attach files"
          className="report-attach button button--sm button--secondary"
          disabled={disabled}
          onClick={() => input.current?.click()}
        >
          📎 Attach files
        </button>
        <span className="text-xs text-muted">or paste, or drop</span>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.currentTarget.files?.length) files.add(e.currentTarget.files);
            e.currentTarget.value = '';
          }}
        />
      </div>
      {files.items.length > 0 && (
        <>
          <ul className="report-attachments flex flex-wrap gap-2">
            {files.items.map((p) => (
              <li
                key={p.key}
                className="report-attachment relative flex h-14 max-w-48 items-center gap-2 overflow-hidden rounded-xl border border-separator pe-6"
                title={p.error ? `${p.name}: ${p.error}` : p.name}
              >
                {p.preview ? (
                  <img
                    src={p.preview}
                    alt={p.name}
                    className="h-full w-14 object-cover"
                  />
                ) : (
                  <span className="grid h-full w-12 place-items-center bg-default text-lg">
                    📄
                  </span>
                )}
                <span className="flex min-w-0 flex-col text-xs">
                  <span className="truncate">{p.name}</span>
                  <span
                    className={p.error ? 'text-danger' : 'text-muted'}
                    data-state={
                      p.error ? 'failed' : p.saved ? 'ready' : 'saving'
                    }
                  >
                    {p.error ??
                      (p.saved ? formatBytes(p.saved.size) : 'Adding…')}
                  </span>
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${p.name}`}
                  className="absolute end-1 top-1 text-xs text-muted"
                  disabled={disabled}
                  onClick={() => files.remove(p.key)}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
          <span className="report-files-note text-xs text-muted">
            Theodore doesn't upload these: GitHub takes files only on its own
            page. Once the issue is open, you drop them into a comment there,
            and you see them before they go.
          </span>
        </>
      )}
    </div>
  );
}

type Send =
  | { phase: 'editing' }
  | { phase: 'sending' }
  | { phase: 'failed'; message: string }
  | { phase: 'done'; issue: ReportedIssue; files: Attachment[] };

function IssueForm({
  target,
  withLogs,
  context,
  title,
  comment,
  files,
  onTitle,
  onComment,
}: {
  target: IssueTarget;
  withLogs: boolean;
  /** A chat report's id: its conversation and run's logs go with it. */
  context: string | null;
  title: string;
  comment: string;
  /** Files to add on GitHub after the issue opens (never posted). */
  files: Attachments;
  onTitle: (v: string) => void;
  onComment: (v: string) => void;
}) {
  const [send, setSend] = useState<Send>({ phase: 'editing' });
  // From a chat, what goes is shown from the start.
  const [showPreview, setShowPreview] = useState(context != null);
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
            context,
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
  }, [showPreview, filled, title, comment, withLogs, context]);

  if (send.phase === 'done')
    return <Opened issue={send.issue} files={send.files} />;

  const submit = () => {
    // The files go after the issue, by the user on GitHub: kept here.
    const attached = files.saved;
    setSend({ phase: 'sending' });
    api
      .submitIssue({
        title,
        comment,
        with_logs: withLogs,
        draft: draft.current,
        context,
      })
      .then(
        (issue) => {
          setSend({ phase: 'done', issue, files: attached });
          // Posted: coming back to this mode starts a new report.
          onTitle('');
          onComment('');
          files.clear();
        },
        (e: unknown) => setSend({ phase: 'failed', message: message(e) }),
      );
  };
  const sending = send.phase === 'sending';
  // A preview from the other mode, or with(out) the conversation, is stale
  // until the next one lands.
  const shown =
    preview &&
    (preview.logs != null) === withLogs &&
    (preview.context != null) === (context != null)
      ? preview
      : null;
  const extra =
    context != null
      ? withLogs
        ? ", with this conversation and this run's redacted log lines"
        : ', with this conversation'
      : withLogs
        ? ', with the newest redacted log lines'
        : '';

  return (
    <div className="report-issue flex flex-col gap-3">
      <span className="report-public text-xs text-warning">
        Posted publicly as @{target.login} on github.com/{target.repo}
        {extra}. Anyone can read it.
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
          {...fileHandlers(files.add)}
        />
      </label>
      <ReportFiles files={files} disabled={sending} />
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
              <>
                <PreviewBody preview={shown} />
                {files.saved.length > 0 && (
                  <span className="report-preview-files text-xs text-muted">
                    Not in the issue: {files.saved.length}{' '}
                    {files.saved.length === 1 ? 'file' : 'files'} (
                    {files.saved.map((a) => a.name).join(', ')}), for you to add
                    on GitHub once it's open.
                  </span>
                )}
              </>
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
          disabled={!filled || sending || files.busy}
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

/** The body as posted; the conversation and the logs blocks folded. */
function PreviewBody({ preview }: { preview: IssuePreview }) {
  const rest = preview.logs
    ? preview.body.slice(0, preview.body.length - preview.logs.length)
    : preview.body;
  const at = preview.context ? rest.indexOf(preview.context) : -1;
  const head = at >= 0 ? rest.slice(0, at) : rest;
  return (
    <>
      <span className="report-preview-title font-medium">{preview.title}</span>
      <pre className="report-preview-body whitespace-pre-wrap break-words font-mono text-xs">
        {head}
      </pre>
      {preview.context && at >= 0 && (
        <details className="report-preview-context text-xs" open>
          <summary className="cursor-pointer text-muted">
            The conversation, as posted
          </summary>
          <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono">
            {preview.context.trim()}
          </pre>
        </details>
      )}
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

function Opened({
  issue,
  files,
}: {
  issue: ReportedIssue;
  files: Attachment[];
}) {
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
      {files.length > 0 && <AddOnGitHub issue={issue} files={files} />}
    </div>
  );
}

type Staged =
  | { phase: 'idle' }
  | { phase: 'staging' }
  | { phase: 'ready'; dir: string }
  | { phase: 'failed'; message: string };

/** The files, for the user to add on GitHub: copied into one folder shown
 *  in Finder, and the issue opened in the browser, to drop them into a
 *  comment. GitHub uploads them there, as the user; Theodore never does. */
function AddOnGitHub({
  issue,
  files,
}: {
  issue: ReportedIssue;
  files: Attachment[];
}) {
  const [staged, setStaged] = useState<Staged>({ phase: 'idle' });
  const go = () => {
    setStaged({ phase: 'staging' });
    api.stageReportFiles(files.map((a) => a.id)).then(
      (s) => {
        setStaged({ phase: 'ready', dir: s.dir });
        const first = s.paths[0];
        if (first) void api.revealReport(first).catch(() => {});
        openExternal(issue.url);
      },
      (e: unknown) => setStaged({ phase: 'failed', message: message(e) }),
    );
  };
  const n = files.length;
  return (
    <div className="report-add-files flex flex-col gap-2 rounded-xl bg-default/50 px-3 py-2">
      <span className="text-xs">
        Add your {n} {n === 1 ? 'file' : 'files'} (
        {files.map((a) => a.name).join(', ')}): GitHub takes them only on its
        own page. Drag them from Finder into a comment on #{issue.number}.
      </span>
      {staged.phase === 'failed' && (
        <span className="text-xs text-danger">{staged.message}</span>
      )}
      {staged.phase === 'ready' && (
        <span className="report-staged break-all font-mono text-xs text-muted">
          {staged.dir}
        </span>
      )}
      <button
        type="button"
        className="report-stage button button--sm button--secondary self-start"
        disabled={staged.phase === 'staging'}
        onClick={go}
      >
        {staged.phase === 'staging' ? (
          <>
            <PlainSpinner /> Copying…
          </>
        ) : (
          'Show files and open the issue'
        )}
      </button>
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

export const ReportProblemModal = observer(function ReportProblemModal() {
  const ui = useUi();
  const draft = ui.reportDraft;
  return (
    <Shell title="Report a problem" onClose={() => ui.closeModal()}>
      {/* A new draft starts the form over. */}
      <ReportProblemView key={draft?.id ?? 'plain'} draft={draft} />
    </Shell>
  );
});
