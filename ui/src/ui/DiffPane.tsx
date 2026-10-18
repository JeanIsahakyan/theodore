import { useState } from 'react';
import {
  ArrowUp,
  Check,
  CircleCheck,
  Eye,
  FileCode,
  Plus,
  Sparkles,
} from '@gravity-ui/icons';
import { Alert, Button, Card, Chip, TextArea, Tooltip } from '@heroui/react';
import { observer } from 'mobx-react-lite';
import { Code, langOf, rich } from '../highlight';
import { api } from '../core/api';
import type {
  Anchor,
  DiffLine,
  FileDiff,
  Hunk,
  HunkId,
  PrId,
  Revision,
  Side,
} from '../gen/contract';
import {
  addDraft,
  markGroupRead,
  replyThread,
  resolveThread,
  setFileViewed,
} from '../actions';
import { useRootStore, useUi } from '../stores/context';
import { Btn } from './bits';
import {
  gapsAbove,
  splitRows,
  wordMarks,
  type Gap,
  type SinceKind,
} from './diff';
import type { ReviewMode } from './GroupsPane';

interface ComposerState {
  path: string;
  side: Side;
  line: number;
  /** Set when the comment covers a range; `line` is always the range's end. */
  startLine?: number;
}

function lineAnchor(
  rev: Revision['head'],
  path: string,
  l: DiffLine,
  startLine?: number,
): Anchor | null {
  if (l.kind === 'del') {
    if (l.old_no == null) return null;
    return {
      rev,
      path,
      side: 'old',
      line: l.old_no,
      start_line: startLine ?? null,
      start_side: startLine != null ? 'old' : null,
    };
  }
  if (l.new_no == null) return null;
  return {
    rev,
    path,
    side: 'new',
    line: l.new_no,
    start_line: startLine ?? null,
    start_side: startLine != null ? 'new' : null,
  };
}

const sameAnchor = (a: Anchor, path: string, side: Side, line: number) =>
  a.path === path && a.side === side && a.line === line;

export const DiffPane = observer(function DiffPane({
  pr,
  rev,
  mode,
  since,
  sinceOnly,
  tour,
}: {
  pr: PrId;
  rev: Revision;
  mode: ReviewMode;
  since?: Map<HunkId, SinceKind> | null;
  sinceOnly?: boolean;
  tour?: boolean;
}) {
  const store = useRootStore();
  const [composer, setComposer] = useState<ComposerState | null>(null);
  const [rangeStart, setRangeStart] = useState<{
    path: string;
    side: Side;
    line: number;
  } | null>(null);
  const [outliersOpen, setOutliersOpen] = useState<Record<string, boolean>>({});

  const group =
    mode.mode === 'groups' && mode.group
      ? store.models.groups.get(mode.group)
      : null;
  const groupHunkIds = group ? new Set(group.hunks) : null;
  const showOnlyOutliers =
    !!group &&
    group.kind === 'skim' &&
    group.outliers.length > 0 &&
    !outliersOpen[group.id];
  const outlierSet = group ? new Set(group.outliers) : null;

  let files: FileDiff[] =
    mode.mode === 'files'
      ? rev.files.filter((f) => f.path === mode.file)
      : groupHunkIds
        ? rev.files
            .map((f) => ({
              ...f,
              hunks: f.hunks.filter((h) => groupHunkIds.has(h.id)),
            }))
            .filter((f) => f.hunks.length)
        : rev.files;

  if (showOnlyOutliers && outlierSet) {
    files = files
      .map((f) => ({
        ...f,
        hunks: f.hunks.filter((h) => outlierSet.has(h.id)),
      }))
      .filter((f) => f.hunks.length);
  }

  if (sinceOnly && since) {
    files = files
      .map((f) => ({ ...f, hunks: f.hunks.filter((h) => since.has(h.id)) }))
      .filter((f) => f.hunks.length);
  }

  const totalInGroup =
    mode.mode === 'groups' && groupHunkIds
      ? rev.files.flatMap((f) => f.hunks.filter((h) => groupHunkIds.has(h.id)))
          .length
      : 0;

  return (
    <main className="diff min-w-0 overflow-auto bg-background px-6 pb-20 pt-5">
      {tour && (
        <div className="tour sticky -top-5 z-[3] -mx-6 -mt-5 mb-5 flex items-center gap-3 border-b border-separator bg-surface px-6 py-3 text-sm">
          <Sparkles className="size-4 text-accent" />
          Tour mode — press <kbd className="font-mono">R</kbd> to mark this
          group read and continue
        </div>
      )}
      {mode.mode === 'groups' && mode.group && (
        <GroupCard pr={pr} groupId={mode.group} />
      )}
      {group && group.kind === 'skim' && group.outliers.length > 0 && (
        <Alert
          status={showOnlyOutliers ? 'warning' : 'default'}
          className="outliers mb-4"
        >
          <Alert.Indicator>
            <Sparkles className="size-4" />
          </Alert.Indicator>
          <Alert.Content>
            <Alert.Title>
              {showOnlyOutliers
                ? `Showing ${group.outliers.length} off-pattern edit${group.outliers.length === 1 ? '' : 's'} of ${totalInGroup}`
                : `All ${totalInGroup} hunks in the group`}
            </Alert.Title>
            <Alert.Description>
              This is a mechanical group: the agent checked the rest against the
              pattern — the same replacement, no need to read it.
            </Alert.Description>
          </Alert.Content>
          <Btn
            tone="tertiary"
            onPress={() =>
              setOutliersOpen((o) => ({ ...o, [group.id]: !o[group.id] }))
            }
          >
            {showOnlyOutliers ? 'Show all' : 'Only outliers'}
          </Btn>
        </Alert>
      )}
      {files.map((f) => (
        <FileBlock
          key={f.path}
          pr={pr}
          rev={rev.head}
          file={f}
          since={since}
          composer={composer}
          setComposer={setComposer}
          rangeStart={rangeStart}
          setRangeStart={setRangeStart}
        />
      ))}
    </main>
  );
});

const GroupCard = observer(function GroupCard({
  pr,
  groupId,
}: {
  pr: PrId;
  groupId: string;
}) {
  const store = useRootStore();
  const g = store.models.groups.get(groupId);
  if (!g) return null;
  const read = store.models.hunkReads
    .where((r) => r.pr === pr)
    .map((r) => r.hunk);
  const allRead = g.hunks.every((h) => read.includes(h));
  return (
    <Card className="gcard mb-5 gap-4 p-5">
      <div className="flex items-center gap-3">
        <Chip size="sm" variant="secondary">
          {g.kind}
        </Chip>
        <span className="text-base font-semibold">{g.title}</span>
        <span className="flex-1" />
        <Btn
          tone={allRead ? 'ghost' : 'tertiary'}
          icon={<Check />}
          className={allRead ? 'text-success' : ''}
          isDisabled={allRead}
          onPress={() => markGroupRead(store, pr, g.hunks)}
        >
          {allRead ? 'Read' : 'Mark as read'}
        </Btn>
      </div>
      <p className="rich flex max-w-[78ch] gap-2 text-sm leading-relaxed">
        {rich(g.why)}
      </p>
      {g.check.length > 0 && (
        <div className="flex flex-col gap-1.5 rounded-2xl bg-surface-secondary px-4 py-3 text-sm">
          <span className="text-xs text-muted">What to check</span>
          {g.check.map((c) => (
            <span key={c}>{c}</span>
          ))}
        </div>
      )}
    </Card>
  );
});

/** A collapsed run of unchanged lines, with a button to fetch and reveal it. */
const ContextGap = observer(function ContextGap({
  pr,
  rev,
  path,
  gap,
  lang,
}: {
  pr: PrId;
  rev: Revision['head'];
  path: string;
  gap: Gap;
  lang: ReturnType<typeof langOf>;
}) {
  const store = useRootStore();
  const [want, setWant] = useState(false);
  const key = `${pr}@${rev}:${path}`;
  const res = want
    ? store.files.get(key, () => api.getFile({ pr, rev, path }))
    : null;
  if (res?.status === 'ready' && res.data != null) {
    const allLines = res.data.split('\n');
    const slice = allLines.slice(gap.from - 1, gap.to);
    return (
      <>
        {slice.map((text, i) => {
          const newNo = gap.from + i;
          return (
            <div key={newNo} className="ln t-ctx">
              <span className="no">{newNo - gap.shift}</span>
              <span className="no">{newNo}</span>
              <span className="mark"> </span>
              <Code s={text} lang={lang} />
              <span className="ln-act" />
            </div>
          );
        })}
      </>
    );
  }
  return (
    <div className="gap flex items-center justify-center gap-2 border-y border-separator bg-surface-secondary px-4 py-1 text-xs text-muted">
      <Button
        size="sm"
        variant="ghost"
        isPending={res?.status === 'loading'}
        onPress={() => setWant(true)}
      >
        Load {gap.to - gap.from + 1} line{gap.to - gap.from ? 's' : ''} of
        context
      </Button>
    </div>
  );
});

function FileBlock({
  pr,
  rev,
  file,
  since,
  composer,
  setComposer,
  rangeStart,
  setRangeStart,
}: {
  pr: PrId;
  rev: Revision['head'];
  file: FileDiff;
  since?: Map<HunkId, SinceKind> | null;
  composer: ComposerState | null;
  setComposer: (c: ComposerState | null) => void;
  rangeStart: { path: string; side: Side; line: number } | null;
  setRangeStart: (r: { path: string; side: Side; line: number } | null) => void;
}) {
  const store = useRootStore();
  const ui = useUi();
  const lang = langOf(file.path);
  const viewed = store.models.fileViews
    .where((v) => v.pr === pr && v.path === file.path)
    .at(-1);
  const isViewed = viewed?.state === 'viewed';
  if (file.flags.some((f) => f.kind === 'oversize' || f.kind === 'binary')) {
    return (
      <Card className="file mb-4 gap-0 overflow-hidden p-4 text-sm text-muted">
        {file.path}: not shown ({file.flags.map((f) => f.kind).join(', ')})
      </Card>
    );
  }
  const gaps = gapsAbove(file.hunks);
  return (
    <Card className="file mb-4 gap-0 overflow-hidden p-0">
      <header className="file-h sticky top-0 z-[2] flex items-center gap-3 border-b border-separator bg-surface px-4 py-2.5 text-sm">
        <FileCode className="size-4 shrink-0 text-muted" />
        <span className="min-w-0 truncate font-mono text-[13px] font-medium">
          {file.path}
        </span>
        {file.status === 'added' && (
          <Chip size="sm" variant="soft" color="success">
            new file
          </Chip>
        )}
        {file.status === 'deleted' && (
          <Chip size="sm" variant="soft" color="danger">
            deleted
          </Chip>
        )}
        <span className="shrink-0 whitespace-nowrap text-xs tabular-nums">
          <span className="text-success">+{file.additions}</span>{' '}
          <span className="text-danger">−{file.deletions}</span>
        </span>
        <span className="flex-1" />
        <Button
          size="sm"
          variant={isViewed ? 'secondary' : 'tertiary'}
          className="viewed-toggle gap-1.5"
          onPress={() => setFileViewed(store, pr, file.path, !isViewed)}
        >
          {isViewed ? (
            <CircleCheck className="size-4 text-success" />
          ) : (
            <Eye className="size-4" />
          )}
          Viewed
        </Button>
      </header>
      {file.hunks.map((h) => (
        <div key={h.id}>
          {gaps.has(h.id) && (
            <ContextGap
              pr={pr}
              rev={rev}
              path={file.path}
              gap={gaps.get(h.id)!}
              lang={lang}
            />
          )}
          {ui.diffView === 'split' ? (
            <SplitHunkView
              pr={pr}
              rev={rev}
              path={file.path}
              h={h}
              lang={lang}
              since={since?.get(h.id)}
              composer={composer}
              setComposer={setComposer}
              rangeStart={rangeStart}
              setRangeStart={setRangeStart}
            />
          ) : (
            <HunkView
              pr={pr}
              rev={rev}
              path={file.path}
              h={h}
              lang={lang}
              since={since?.get(h.id)}
              composer={composer}
              setComposer={setComposer}
              rangeStart={rangeStart}
              setRangeStart={setRangeStart}
            />
          )}
        </div>
      ))}
    </Card>
  );
}

function SinceBadge({ kind }: { kind?: SinceKind }) {
  if (!kind) return null;
  return (
    <Chip
      size="sm"
      variant="soft"
      color={kind === 'new' ? 'success' : 'warning'}
    >
      {kind === 'new' ? 'new since' : 'changed since'} last visit
    </Chip>
  );
}

function HunkView({
  pr,
  rev,
  path,
  h,
  lang,
  since,
  composer,
  setComposer,
  rangeStart,
  setRangeStart,
}: {
  pr: PrId;
  rev: Revision['head'];
  path: string;
  h: Hunk;
  lang: ReturnType<typeof langOf>;
  since?: SinceKind;
  composer: ComposerState | null;
  setComposer: (c: ComposerState | null) => void;
  rangeStart: { path: string; side: Side; line: number } | null;
  setRangeStart: (r: { path: string; side: Side; line: number } | null) => void;
}) {
  const store = useRootStore();
  const read =
    store.models.hunkReads.where((r) => r.pr === pr && r.hunk === h.id).length >
    0;
  const marks = wordMarks(h.lines);
  return (
    <div
      className={`hunk border-t border-separator first:border-t-0 ${read ? 'read' : ''}`}
    >
      <div className="flex min-h-8 items-center gap-3 px-4 py-1 text-xs text-muted bg-surface-secondary">
        <span className="tabular-nums">
          {h.header ||
            `@@ -${h.old_start},${h.old_lines} +${h.new_start},${h.new_lines} @@`}
        </span>
        <SinceBadge kind={since} />
        <span className="flex-1" />
        {read && (
          <span className="inline-flex items-center gap-1 text-success">
            <Check className="size-3.5" /> read
          </span>
        )}
      </div>
      <div className="lines">
        {h.lines.map((l, i) => (
          <Line
            key={i}
            pr={pr}
            rev={rev}
            path={path}
            l={l}
            lang={lang}
            marks={marks.get(i)}
            composer={composer}
            setComposer={setComposer}
            rangeStart={rangeStart}
            setRangeStart={setRangeStart}
          />
        ))}
      </div>
    </div>
  );
}

/** Side-by-side rendering of one hunk, using `splitRows` to pair del/add lines. */
function SplitHunkView({
  pr,
  rev,
  path,
  h,
  lang,
  since,
  composer,
  setComposer,
  rangeStart,
  setRangeStart,
}: {
  pr: PrId;
  rev: Revision['head'];
  path: string;
  h: Hunk;
  lang: ReturnType<typeof langOf>;
  since?: SinceKind;
  composer: ComposerState | null;
  setComposer: (c: ComposerState | null) => void;
  rangeStart: { path: string; side: Side; line: number } | null;
  setRangeStart: (r: { path: string; side: Side; line: number } | null) => void;
}) {
  const store = useRootStore();
  const read =
    store.models.hunkReads.where((r) => r.pr === pr && r.hunk === h.id).length >
    0;
  const marks = wordMarks(h.lines);
  const rows = splitRows(h.lines);
  return (
    <div
      className={`hunk split border-t border-separator first:border-t-0 ${read ? 'read' : ''}`}
    >
      <div className="flex min-h-8 items-center gap-3 px-4 py-1 text-xs text-muted bg-surface-secondary">
        <span className="tabular-nums">
          {h.header ||
            `@@ -${h.old_start},${h.old_lines} +${h.new_start},${h.new_lines} @@`}
        </span>
        <SinceBadge kind={since} />
        <span className="flex-1" />
        {read && (
          <span className="inline-flex items-center gap-1 text-success">
            <Check className="size-3.5" /> read
          </span>
        )}
      </div>
      <div className="lines split-lines">
        {rows.map((row, i) => (
          <div key={i} className="split-row grid grid-cols-2">
            <div className="split-col">
              {row.l != null && (
                <Line
                  pr={pr}
                  rev={rev}
                  path={path}
                  l={h.lines[row.l]!}
                  lang={lang}
                  marks={marks.get(row.l)}
                  composer={composer}
                  setComposer={setComposer}
                  rangeStart={rangeStart}
                  setRangeStart={setRangeStart}
                />
              )}
            </div>
            <div className="split-col">
              {row.r != null && (
                <Line
                  pr={pr}
                  rev={rev}
                  path={path}
                  l={h.lines[row.r]!}
                  lang={lang}
                  marks={marks.get(row.r)}
                  composer={composer}
                  setComposer={setComposer}
                  rangeStart={rangeStart}
                  setRangeStart={setRangeStart}
                />
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const Line = observer(function Line({
  pr,
  rev,
  path,
  l,
  lang,
  marks,
  composer,
  setComposer,
  rangeStart,
  setRangeStart,
}: {
  pr: PrId;
  rev: Revision['head'];
  path: string;
  l: DiffLine;
  lang: ReturnType<typeof langOf>;
  marks?: [number, number][];
  composer: ComposerState | null;
  setComposer: (c: ComposerState | null) => void;
  rangeStart: { path: string; side: Side; line: number } | null;
  setRangeStart: (r: { path: string; side: Side; line: number } | null) => void;
}) {
  const store = useRootStore();
  const anchor = lineAnchor(rev, path, l);
  const prThreads = store.models.prDetails.get(pr)?.threads ?? [];
  const threads = anchor
    ? prThreads.filter(
        (t) =>
          !!t.anchor && sameAnchor(t.anchor, path, anchor.side, anchor.line),
      )
    : [];
  const drafts = anchor
    ? store.models.drafts.where((d) =>
        sameAnchor(d.anchor, path, anchor.side, anchor.line),
      )
    : [];
  const composing =
    anchor &&
    composer &&
    sameAnchor(anchor, path, composer.side, composer.line);
  const composerAnchor =
    composing && anchor ? lineAnchor(rev, path, l, composer!.startLine) : null;
  return (
    <>
      <div className={`ln t-${l.kind}`}>
        <span className="no">{l.old_no ?? ''}</span>
        <span className="no">{l.new_no ?? ''}</span>
        <span className="mark">
          {l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}
        </span>
        <Code s={l.text} lang={lang} marks={marks} />
        <span className="ln-act">
          {anchor && (
            <Tooltip>
              <Button
                isIconOnly
                size="sm"
                aria-label="comment"
                className="h-5 min-w-5 w-5 rounded-xl text-xs"
                onPress={(e) => {
                  if (
                    e.shiftKey &&
                    rangeStart &&
                    rangeStart.path === path &&
                    rangeStart.side === anchor.side
                  ) {
                    const startLine = Math.min(rangeStart.line, anchor.line);
                    const endLine = Math.max(rangeStart.line, anchor.line);
                    setComposer({
                      path,
                      side: anchor.side,
                      line: endLine,
                      startLine: startLine !== endLine ? startLine : undefined,
                    });
                  } else {
                    setRangeStart({
                      path,
                      side: anchor.side,
                      line: anchor.line,
                    });
                    setComposer({ path, side: anchor.side, line: anchor.line });
                  }
                }}
              >
                <Plus className="size-3" />
              </Button>
              <Tooltip.Content>
                Comment · shift-click another line for a range
              </Tooltip.Content>
            </Tooltip>
          )}
        </span>
      </div>
      {(threads.length > 0 || drafts.length > 0 || composing) && (
        <div className="flex flex-col gap-2 border-y border-separator bg-background py-2 pl-[108px] pr-3 font-sans text-sm">
          {threads.map((t) => (
            <ThreadView key={t.id} pr={pr} id={t.id} />
          ))}
          {drafts.map((d) => (
            <div
              key={d.id}
              className="draft max-w-[760px] gap-2 rounded-2xl border border-warning/40 px-4 py-3"
            >
              <div className="text-xs text-muted">pending draft</div>
              <div className="text-sm">{d.body}</div>
            </div>
          ))}
          {composing && composerAnchor && (
            <Composer
              pr={pr}
              anchor={composerAnchor}
              onClose={() => setComposer(null)}
            />
          )}
        </div>
      )}
    </>
  );
});

const ThreadView = observer(function ThreadView({
  pr,
  id,
}: {
  pr: PrId;
  id: string;
}) {
  const store = useRootStore();
  const t = store.models.prDetails.get(pr)?.threads.find((th) => th.id === id);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  if (!t) return null;
  const send = () => {
    const body = reply.trim();
    if (!body) return;
    setBusy(true);
    void replyThread(store, pr, id, body)
      .then(() => setReply(''))
      .finally(() => setBusy(false));
  };
  return (
    <Card
      className={`thread max-w-[760px] gap-0 overflow-hidden p-0 ${t.resolved ? 'resolved' : ''}`}
    >
      <div className="flex items-center gap-2 border-b border-separator px-4 py-2">
        <Chip
          size="sm"
          variant="soft"
          color={t.resolved ? 'success' : 'warning'}
        >
          {t.resolved ? 'Resolved' : 'Open'}
        </Chip>
        <span className="text-xs text-muted">{t.comments.length} comments</span>
        <span className="flex-1" />
        {!t.resolved && (
          <Button
            size="sm"
            variant="ghost"
            className="gap-1.5"
            onPress={() => void resolveThread(store, pr, id, true)}
          >
            <Check className="size-3.5" />
            Resolve
          </Button>
        )}
      </div>
      <div className="flex flex-col gap-3 px-4 py-3">
        {t.comments.map((c, i) => (
          <div key={c.id ?? i} className="flex flex-col gap-0.5 text-sm">
            <span className="font-medium">{c.author.login}</span>
            <span>{c.body}</span>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-1.5 border-t border-separator px-3 py-2">
        <TextArea
          aria-label="Reply"
          rows={1}
          fullWidth
          value={reply}
          placeholder="Reply…"
          className="font-sans text-xs"
          onChange={(e) => setReply(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && reply.trim()) {
              send();
            }
          }}
        />
        <Button
          isIconOnly
          size="sm"
          aria-label="Send reply"
          isPending={busy}
          isDisabled={!reply.trim()}
          onPress={send}
        >
          <ArrowUp className="size-4" />
        </Button>
      </div>
    </Card>
  );
});

function Composer({
  pr,
  anchor,
  onClose,
}: {
  pr: PrId;
  anchor: Anchor;
  onClose: () => void;
}) {
  const store = useRootStore();
  const [text, setText] = useState('');
  return (
    <Card className="composer max-w-[760px] gap-1.5 p-2">
      {anchor.start_line != null && (
        <div className="px-1 text-xs text-muted">
          Commenting on lines {anchor.start_line}–{anchor.line}
        </div>
      )}
      <TextArea
        autoFocus
        fullWidth
        rows={3}
        aria-label="comment"
        value={text}
        placeholder="Comment… ⌘⏎ to add to review"
        className="font-mono text-xs"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim()) {
            addDraft(store, pr, anchor, text.trim());
            onClose();
          }
          if (e.key === 'Escape') onClose();
        }}
      />
      <div className="flex items-center gap-1.5">
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onPress={onClose}>
          Cancel
        </Button>
        <Btn
          tone="primary"
          icon={<ArrowUp />}
          isDisabled={!text.trim()}
          onPress={() => {
            addDraft(store, pr, anchor, text.trim());
            onClose();
          }}
        >
          Add to review
        </Btn>
      </div>
    </Card>
  );
}
