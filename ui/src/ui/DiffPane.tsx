import { MarkdownDiff } from './MarkdownDiff';
import { isMarkdown } from './mdDiff';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  Check,
  ChevronsDown,
  ChevronsUp,
  CircleCheckFill,
  Eye,
  FileCode,
  Plus,
  Sparkles,
  TriangleExclamation,
} from '@gravity-ui/icons';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Chip,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@heroui/react';
import { observer } from 'mobx-react-lite';
import { Code, langOf, rich } from '../highlight';
import { api } from '../core/api';
import type {
  Anchor,
  DiffLine,
  FileDiff,
  Group,
  Hunk,
  HunkId,
  PrId,
  Revision,
  Severity,
  Side,
} from '../gen/contract';
import { ask, markGroupRead, markHunkRead, setFileViewed } from '../actions';
import { useRootStore, useUi } from '../stores/context';
import { Btn } from './bits';
import { Composer, DraftView, plural, ThreadView } from './Comments';
import { useContextMenu, type ContextMenuItem } from './ContextMenu';
import {
  gapsAbove,
  gapTail,
  sinceCountsFor,
  splitRows,
  wordMarks,
  type Gap,
  type SinceKind,
} from './diff';
import { groupsForRevision, type ReviewMode } from './GroupsPane';
import { nextReviewableGroup } from './review/groups';
import { TourBar } from './review/TourBar';
import { SymbolPeek, type SymbolPeekTarget } from './SymbolPeek';

export interface ComposerState {
  path: string;
  side: Side;
  line: number;
  /** Set when the comment covers a range; `line` is always the range's end. */
  startLine?: number;
}

/** Exported so `Review`'s `C` shortcut can open the composer on the focused
 *  hunk's first changed line the same way a mouse click does. */
export function lineAnchor(
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

/** Lines `lines X–Y`, from the hunk's new-side range (deletions-only hunks
 *  have no new lines to anchor on). */
function hunkRange(h: Hunk): string {
  if (h.new_lines <= 0) return 'deletions only';
  return `lines ${h.new_start}–${h.new_start + h.new_lines - 1}`;
}

/** The identifier under the pointer, from the text node the browser hit. */
function symbolAt(e: React.MouseEvent): string | null {
  if ((e.target as HTMLElement).closest('.ln-act, .no, .mark')) return null;
  const range = document.caretRangeFromPoint?.(e.clientX, e.clientY);
  const node = range?.startContainer;
  if (!range || !node || node.nodeType !== 3) return null;
  const text = node.textContent ?? '';
  let a = range.startOffset;
  let b = a;
  while (a > 0 && /[\w$]/.test(text[a - 1]!)) a--;
  while (b < text.length && /[\w$]/.test(text[b]!)) b++;
  const w = text.slice(a, b);
  return /^[A-Za-z_$][\w$]*$/.test(w) ? w : null;
}

const sevBg: Record<Severity, string> = {
  high: 'bg-danger',
  warn: 'bg-warning',
  info: 'bg-accent',
};

const CHUNK = 40;
const STEP = 20;
/** Below this, side-by-side halves are too narrow to read — fall back to
 *  unified even if the user asked for split. */
const SPLIT_MIN_WIDTH = 760;

/** Tracks an element's rendered width (see `Review.tsx`'s twin of this —
 *  not shared, each file owns its own small copy). No-op without
 *  `ResizeObserver` (tests): one read of `clientWidth`/`innerWidth`, then
 *  it never updates. */
function useElementWidth(ref: { current: HTMLElement | null }): number {
  const [width, setWidth] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth : SPLIT_MIN_WIDTH,
  );
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w != null) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

export const DiffPane = observer(function DiffPane({
  pr,
  rev,
  mode,
  setMode,
  since,
  sinceOnly,
  /** The head you had open last visit, shown short in the since-only banner
   *  — `null` on a first visit, when there's nothing to compare against. */
  baselineSha,
  tour,
  /** Focused hunk and open composer are owned by `Review` — its `J`/`K`/`C`
   *  shortcuts drive them, and the diff pane just renders what they say. */
  focusHunk,
  setFocusHunk,
  composer,
  setComposer,
  /** Bumping `nonce` for a hunk's id fully reveals the context gap directly
   *  above it — `Review`'s `E` shortcut. */
  expandHunk = null,
}: {
  pr: PrId;
  rev: Revision;
  mode: ReviewMode;
  setMode: (m: ReviewMode) => void;
  since?: Map<HunkId, SinceKind> | null;
  sinceOnly?: boolean;
  baselineSha?: string | null;
  /** Active tour state — the reviewable groups in order, which one is
   *  current, and the Back/Next handlers; `null`/absent outside a tour. */
  tour?: {
    groups: Group[];
    index: number;
    onBack: () => void;
    onNext: () => void;
  } | null;
  focusHunk: HunkId | null;
  setFocusHunk: (h: HunkId | null) => void;
  composer: ComposerState | null;
  setComposer: (c: ComposerState | null) => void;
  expandHunk?: { hunk: HunkId; nonce: number } | null;
}) {
  const store = useRootStore();
  const ui = useUi();
  const mainRef = useRef<HTMLDivElement>(null);
  const diffWidth = useElementWidth(mainRef);
  // Split needs room for two readable halves; below that, unified is more
  // useful than two unreadably-thin columns.
  const splitRequested = ui.diffView === 'split';
  const effectiveSplit = splitRequested && diffWidth >= SPLIT_MIN_WIDTH;
  const splitDowngraded = splitRequested && !effectiveSplit;
  const [rangeStart, setRangeStart] = useState<{
    path: string;
    side: Side;
    line: number;
  } | null>(null);
  const [outliersOpen, setOutliersOpen] = useState<Record<string, boolean>>({});
  const [hiddenOpen, setHiddenOpen] = useState<Record<string, boolean>>({});
  const [limit, setLimit] = useState(CHUNK);
  const [peek, setPeek] = useState<SymbolPeekTarget | null>(null);

  // Holding ⌘/Ctrl turns identifiers in the diff into links (styles.css: body.cmd).
  useEffect(() => {
    const on = (e: KeyboardEvent) =>
      document.body.classList.toggle('cmd', e.metaKey || e.ctrlKey);
    const off = () => document.body.classList.remove('cmd');
    window.addEventListener('keydown', on);
    window.addEventListener('keyup', on);
    window.addEventListener('blur', off);
    return () => {
      window.removeEventListener('keydown', on);
      window.removeEventListener('keyup', on);
      window.removeEventListener('blur', off);
      document.body.classList.remove('cmd');
    };
  }, []);

  const group =
    mode.mode === 'groups' && mode.group
      ? store.models.groupsOf(pr).find((g) => g.id === mode.group)
      : null;
  const groupHunkIds = group ? new Set(group.hunks) : null;
  const showOnlyOutliers =
    !!group &&
    group.kind === 'skim' &&
    group.outliers.length > 0 &&
    !outliersOpen[group.id];
  const outlierSet = group ? new Set(group.outliers) : null;
  // Lockfiles and generated code: collapsed by default, same as the
  // prototype — "show anyway" reveals this group's diff like any other.
  const groupCollapsed =
    !!group && group.kind === 'hidden' && !hiddenOpen[group.id];

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

  // A chunked file list resets whenever the group/file/mode changes under it.
  useEffect(() => setLimit(CHUNK), [mode.mode, mode.group, mode.file]);
  const visibleFiles = files.slice(0, limit);

  const totalInGroup =
    mode.mode === 'groups' && groupHunkIds
      ? rev.files.flatMap((f) => f.hunks.filter((h) => groupHunkIds.has(h.id)))
          .length
      : 0;

  const sinceTotals = sinceCountsFor(
    rev.files.flatMap((f) => f.hunks),
    since,
  );

  return (
    <main
      ref={mainRef}
      className="diff min-w-0 overflow-auto bg-background px-6 pb-20 pt-5"
    >
      {tour && (
        <TourBar
          groups={tour.groups}
          index={tour.index}
          onBack={tour.onBack}
          onNext={tour.onNext}
        />
      )}
      {splitDowngraded && (
        <Alert status="default" className="split-note mb-4">
          <Alert.Content>
            <Alert.Title>
              Showing unified — not enough room here for side-by-side.
            </Alert.Title>
          </Alert.Content>
        </Alert>
      )}
      {sinceOnly && (
        <Alert status="accent" className="since-banner mb-4">
          <Alert.Content>
            <Alert.Title>
              Showing only what changed since your last visit
              {baselineSha ? ` (${baselineSha.slice(0, 7)})` : ''}.
            </Alert.Title>
            <Alert.Description>
              {sinceTotals.changed}{' '}
              {sinceTotals.changed === 1 ? 'hunk' : 'hunks'} changed,{' '}
              {sinceTotals.new} new — the rest you've already seen.
            </Alert.Description>
          </Alert.Content>
        </Alert>
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
                : `All ${totalInGroup} edits in the group`}
            </Alert.Title>
            <Alert.Description>
              The agent checked the rest against the pattern: the same
              replacement, no need to read.
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
      {groupCollapsed ? (
        <div className="hidden-group flex items-center gap-3 rounded-2xl border border-dashed border-separator p-3.5 text-muted">
          <span className="flex-1">
            Hidden: {group!.why || 'mechanical or generated changes'} —
            collapsed by default.
          </span>
          <Btn
            tone="tertiary"
            className="show-hidden"
            onPress={() => setHiddenOpen((o) => ({ ...o, [group!.id]: true }))}
          >
            Show anyway
          </Btn>
        </div>
      ) : (
        <>
          {visibleFiles.map((f) => (
            <FileBlock
              key={f.path}
              pr={pr}
              rev={rev.head}
              base={rev.base}
              allFiles={rev.files}
              file={f}
              since={since}
              groupHunkIds={mode.mode === 'groups' ? groupHunkIds : null}
              mode={mode}
              setMode={setMode}
              split={effectiveSplit}
              composer={composer}
              setComposer={setComposer}
              rangeStart={rangeStart}
              setRangeStart={setRangeStart}
              focusHunk={focusHunk}
              setFocusHunk={setFocusHunk}
              expandHunk={expandHunk}
              peek={peek}
              setPeek={setPeek}
            />
          ))}
          {files.length > visibleFiles.length && (
            <div className="more-files flex items-center justify-center gap-3 py-2 text-sm text-muted">
              Showing {visibleFiles.length} of {files.length} files
              <Btn onPress={() => setLimit((n) => n + CHUNK * 2)}>
                {Math.min(CHUNK * 2, files.length - visibleFiles.length)} more
              </Btn>
              <Btn tone="ghost" onPress={() => setLimit(files.length)}>
                All
              </Btn>
            </div>
          )}
        </>
      )}
      <div className="flex justify-center py-4">
        {mode.mode === 'groups' && !tour && (
          <NextGroup pr={pr} rev={rev} mode={mode} setMode={setMode} />
        )}
      </div>
    </main>
  );
});

/** Longer risks wrap on their own line instead of stretching the chip. */
const RISK_CHIP_MAX = 48;

const GroupCard = observer(function GroupCard({
  pr,
  groupId,
}: {
  pr: PrId;
  groupId: string;
}) {
  const store = useRootStore();
  const g = store.models.groupsOf(pr).find((x) => x.id === groupId);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  if (!g) return null;
  // Same sequence `GroupsPane` numbers groups in — includes hidden groups
  // so a badge doesn't shift when one gets "shown anyway".
  const n = store.models.groupsOf(pr).findIndex((x) => x.id === g.id) + 1;
  const read = store.models.hunkReads
    .where((r) => r.pr === pr)
    .map((r) => r.hunk);
  const allRead = g.hunks.every((h) => read.includes(h));
  return (
    <Card className="gcard mb-5 gap-4 p-5">
      <div className="flex items-center gap-3">
        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-accent-soft text-sm font-semibold text-accent tabular-nums">
          {n}
        </span>
        <Typography.Heading
          level={5}
          className="min-w-0 truncate"
          title={g.title}
        >
          {g.title}
        </Typography.Heading>
        {g.risk && g.risk.length <= RISK_CHIP_MAX && (
          <Chip
            size="sm"
            variant="soft"
            color="warning"
            className="shrink-0 gap-1"
          >
            <TriangleExclamation className="size-3.5" />
            {rich(g.risk)}
          </Chip>
        )}
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
      {g.risk && g.risk.length > RISK_CHIP_MAX && (
        <p className="flex max-w-[78ch] gap-2 text-sm leading-relaxed text-warning">
          <TriangleExclamation className="mt-1 size-4 shrink-0" />
          <span>{rich(g.risk)}</span>
        </p>
      )}
      <p className="rich flex max-w-[78ch] gap-2 text-sm leading-relaxed">
        <Sparkles
          className="mt-1 size-4 shrink-0 text-accent"
          aria-label="agent explanation"
        />
        <span>{rich(g.why)}</span>
      </p>
      {g.check.length > 0 && (
        <div className="flex flex-col gap-2 rounded-2xl bg-surface-secondary px-4 py-3">
          <span className="text-xs text-muted">What to check</span>
          {g.check.map((c) => (
            <Checkbox
              key={c}
              isSelected={!!checked[c]}
              onChange={() => setChecked((s) => ({ ...s, [c]: !s[c] }))}
            >
              <Checkbox.Content
                className={checked[c] ? 'text-muted line-through' : ''}
              >
                <Checkbox.Control>
                  <Checkbox.Indicator />
                </Checkbox.Control>
                <span>{rich(c)}</span>
              </Checkbox.Content>
            </Checkbox>
          ))}
        </div>
      )}
    </Card>
  );
});

function NextGroupInner({
  pr,
  rev,
  mode,
  setMode,
}: {
  pr: PrId;
  rev: Revision;
  mode: ReviewMode;
  setMode: (m: ReviewMode) => void;
}) {
  const store = useRootStore();
  const groups = groupsForRevision(store, pr, rev);
  // Skips hidden groups — nothing to review there until shown by hand.
  const next = nextReviewableGroup(groups, mode.group);
  if (!next) return null;
  return (
    <Btn
      icon={<ArrowRight />}
      onPress={() =>
        setMode({ mode: 'groups', group: next.id, file: mode.file })
      }
    >
      Next: {next.title}
    </Btn>
  );
}

/** «Show more» for a gap; lines are revealed from the hunk outwards. */
function Expander({
  left,
  dir,
  onReveal,
}: {
  left: number;
  dir: 'up' | 'down';
  onReveal: (n: number) => void;
}) {
  const Icon = dir === 'up' ? ChevronsUp : ChevronsDown;
  return (
    <span className="expander -ml-2 flex items-center gap-0.5">
      {left > STEP && (
        <Button
          size="sm"
          variant="ghost"
          className="h-6 gap-1 px-1.5 text-xs text-muted"
          onPress={() => onReveal(STEP)}
        >
          <Icon className="size-3.5" />
          {STEP}
        </Button>
      )}
      <Button
        size="sm"
        variant="ghost"
        className="expand-all h-6 gap-1 px-1.5 text-xs text-muted"
        onPress={() => onReveal(Infinity)}
      >
        {left <= STEP && <Icon className="size-3.5" />}
        {left > STEP ? `all ${left}` : plural(left, 'line', 'lines')}
      </Button>
    </span>
  );
}

/** A collapsed run of unchanged lines above a hunk; fetches the file lazily
 *  (unlike the prototype's eagerly-mocked `sources`) and reveals it in
 *  `STEP`-sized bites from the hunk outward, closest lines first. */
const ContextGap = observer(function ContextGap({
  pr,
  rev,
  path,
  gap,
  lang,
  expand,
}: {
  pr: PrId;
  rev: Revision['head'];
  path: string;
  gap: Gap;
  lang: ReturnType<typeof langOf>;
  /** A nonce from `Review`'s `E` shortcut — any change fully reveals the
   *  gap once (not on every render, so the manual "load N lines" buttons
   *  below still work undisturbed). */
  expand?: number | null;
}) {
  const store = useRootStore();
  const [shown, setShown] = useState(0);
  const total = gap.to - gap.from + 1;
  const appliedExpand = useRef<number | null>(null);
  useEffect(() => {
    if (expand != null && expand !== appliedExpand.current) {
      appliedExpand.current = expand;
      setShown(total);
    }
  }, [expand, total]);
  const key = `${pr}@${rev}:${path}`;
  const res =
    shown > 0
      ? store.files.get(key, () => api.getFile({ pr, rev, path }))
      : null;
  if (res?.status === 'ready' && res.data != null) {
    const allLines = res.data.split('\n');
    const from = gap.to - shown + 1;
    const slice = allLines.slice(from - 1, gap.to);
    const left = total - shown;
    return (
      <>
        {left > 0 && (
          <div className="flex items-center gap-3 border-b border-separator bg-surface-secondary px-4 py-1 text-xs text-muted">
            <Expander
              left={left}
              dir="up"
              onReveal={(n) => setShown((s) => Math.min(total, s + n))}
            />
          </div>
        )}
        {slice.map((text, i) => {
          const newNo = from + i;
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
        onPress={() => setShown(Math.min(STEP, total))}
      >
        Load {total} line{total === 1 ? '' : 's'} of context
      </Button>
    </div>
  );
});

/** The gap after a file's last shown hunk, fetched the same lazy way. */
const FileTail = observer(function FileTail({
  pr,
  rev,
  path,
  hunks,
  lang,
}: {
  pr: PrId;
  rev: Revision['head'];
  path: string;
  hunks: Hunk[];
  lang: ReturnType<typeof langOf>;
}) {
  const store = useRootStore();
  const [shown, setShown] = useState(0);
  const key = `${pr}@${rev}:${path}`;
  const res =
    shown > 0
      ? store.files.get(key, () => api.getFile({ pr, rev, path }))
      : null;
  if (res?.status === 'ready' && res.data != null) {
    const allLines = res.data.split('\n');
    const gap = gapTail(hunks, allLines.length);
    if (!gap) return null;
    const to = Math.min(gap.to, gap.from + shown - 1);
    const slice = allLines.slice(gap.from - 1, to);
    const total = gap.to - gap.from + 1;
    const left = total - shown;
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
        {left > 0 && (
          <div className="flex items-center gap-3 border-t border-separator bg-surface-secondary px-4 py-1 text-xs text-muted">
            <Expander
              left={left}
              dir="down"
              onReveal={(n) => setShown((s) => Math.min(total, s + n))}
            />
            <span>to end of file</span>
          </div>
        )}
      </>
    );
  }
  return (
    <div className="gap flex items-center justify-center gap-2 border-t border-separator bg-surface-secondary px-4 py-1 text-xs text-muted">
      <Button
        size="sm"
        variant="ghost"
        isPending={res?.status === 'loading'}
        onPress={() => setShown(STEP)}
      >
        Load to end of file
      </Button>
    </div>
  );
});

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

interface LineProps {
  pr: PrId;
  rev: Revision['head'];
  path: string;
  composer: ComposerState | null;
  setComposer: (c: ComposerState | null) => void;
  rangeStart: { path: string; side: Side; line: number } | null;
  setRangeStart: (r: { path: string; side: Side; line: number } | null) => void;
  peek: SymbolPeekTarget | null;
  setPeek: (p: SymbolPeekTarget | null) => void;
}

function FileBlockInner({
  pr,
  rev,
  base,
  allFiles,
  file,
  since,
  groupHunkIds,
  mode,
  setMode,
  split,
  composer,
  setComposer,
  rangeStart,
  setRangeStart,
  focusHunk,
  setFocusHunk,
  expandHunk,
  peek,
  setPeek,
}: {
  pr: PrId;
  rev: Revision['head'];
  base: Revision['base'];
  allFiles: FileDiff[];
  file: FileDiff;
  since?: Map<HunkId, SinceKind> | null;
  groupHunkIds: Set<HunkId> | null;
  mode: ReviewMode;
  setMode: (m: ReviewMode) => void;
  split: boolean;
  focusHunk: HunkId | null;
  setFocusHunk: (h: HunkId | null) => void;
  expandHunk?: { hunk: HunkId; nonce: number } | null;
} & Omit<LineProps, 'path'>) {
  const store = useRootStore();
  const lang = langOf(file.path);
  const viewed = store.models.fileViews
    .where((v) => v.pr === pr && v.path === file.path)
    .at(-1);
  const isViewed = viewed?.state === 'viewed';
  const local = store.models.prSummaries.get(pr)?.pr.repo.host === 'local';
  const fileSince = sinceCountsFor(file.hunks, since);
  const fileSinceCount = fileSince.new + fileSince.changed;
  const [shown, setShown] = useState(false);
  const md = isMarkdown(file.path) && file.status !== 'deleted';
  const [preview, setPreview] = useState(false);
  const generatedFlag = file.flags.find((f) => f.kind === 'generated');
  const summaryForMenu = store.models.prSummaries.get(pr);
  // Hooks must run unconditionally, so this is built before the early
  // return below (the file header — and its menu — still renders either way).
  const fileMenu = useContextMenu((): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [
      {
        id: 'mark-viewed',
        label: isViewed ? 'Mark not viewed' : 'Mark viewed',
        onAction: () => setFileViewed(store, pr, file.path, !isViewed),
      },
      {
        id: 'copy-path',
        label: 'Copy path',
        onAction: () => void navigator.clipboard.writeText(file.path),
      },
    ];
    if (summaryForMenu) {
      items.push({
        id: 'open-github',
        label: 'Open on GitHub',
        onAction: () => window.open(`${summaryForMenu.url}/files`, '_blank'),
      });
    }
    if (generatedFlag || file.status === 'deleted') {
      items.push({
        id: 'collapse',
        label: shown ? 'Collapse' : 'Expand',
        onAction: () => setShown((v) => !v),
      });
    }
    return items;
  });

  const flag = file.flags.find(
    (f) => f.kind === 'oversize' || f.kind === 'binary',
  );
  if (flag) {
    return (
      <Card className="file mb-4 gap-0 overflow-hidden p-4 text-sm text-muted">
        {file.path}: not shown (
        {flag.kind === 'oversize'
          ? `${flag.lines.toLocaleString('en')} lines, over the size limit`
          : 'binary file'}
        )
      </Card>
    );
  }

  const collapsedFile =
    (!!generatedFlag || file.status === 'deleted') && !shown;
  const others =
    groupHunkIds && mode.mode === 'groups'
      ? (allFiles.find((f) => f.path === file.path)?.hunks ?? []).filter(
          (h) => !groupHunkIds.has(h.id),
        )
      : [];
  const gaps = gapsAbove(file.hunks);
  const last = file.hunks[file.hunks.length - 1];

  return (
    <Card className="file mb-4 gap-0 overflow-hidden p-0">
      <header
        className="file-h sticky top-0 z-[2] flex items-center gap-3 border-b border-separator bg-surface px-4 py-2.5 text-sm"
        onContextMenu={fileMenu}
      >
        <FileCode className="size-4 shrink-0 text-muted" />
        {/* `dir="rtl"` truncates from the start so the filename (the end of
         *  the path) stays visible; the inner `dir="ltr"` keeps old→new
         *  order correct for renames regardless of the outer direction. */}
        <span
          className="min-w-0 truncate font-mono text-[13px]"
          dir="rtl"
          title={file.old_path ? `${file.old_path} → ${file.path}` : file.path}
        >
          <span dir="ltr">
            {file.old_path && (
              <span className="text-muted line-through decoration-muted/60">
                {file.old_path}
              </span>
            )}
            {file.old_path && <span className="px-1.5 text-muted">→</span>}
            <span className="font-medium">{file.path}</span>
          </span>
        </span>
        {file.status === 'added' && (
          <Chip size="sm" variant="soft" color="success" className="shrink-0">
            new file
          </Chip>
        )}
        {file.status === 'renamed' && (
          <Chip
            size="sm"
            variant="soft"
            color="accent"
            className="renamed shrink-0"
          >
            renamed
            {file.similarity != null ? ` · ${file.similarity}% similar` : ''}
          </Chip>
        )}
        {file.status === 'deleted' && (
          <Chip size="sm" variant="soft" color="danger" className="shrink-0">
            deleted
          </Chip>
        )}
        {generatedFlag && (
          <Chip size="sm" variant="secondary" className="generated shrink-0">
            generated · {generatedFlag.reason}
          </Chip>
        )}
        <span className="shrink-0 whitespace-nowrap text-xs tabular-nums">
          <span className="text-success">+{file.additions}</span>{' '}
          <span className="text-danger">−{file.deletions}</span>
        </span>
        {fileSinceCount > 0 && (
          <Tooltip>
            <Chip
              size="sm"
              variant="soft"
              color={fileSince.new > 0 ? 'success' : 'warning'}
              className="since-file shrink-0"
            >
              {fileSinceCount} since last visit
            </Chip>
            <Tooltip.Content>
              {fileSince.new > 0 && `${fileSince.new} new`}
              {fileSince.new > 0 && fileSince.changed > 0 && ', '}
              {fileSince.changed > 0 && `${fileSince.changed} changed`}
            </Tooltip.Content>
          </Tooltip>
        )}
        {others.map((h) => {
          const g = store.models
            .groupsOf(pr)
            .find((x) => x.hunks.includes(h.id));
          if (!g) return null;
          return (
            <Tooltip key={h.id}>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 max-w-40 shrink-0 gap-1 px-2 text-xs text-accent"
                onPress={() =>
                  setMode({ mode: 'groups', group: g.id, file: file.path })
                }
              >
                <span className="truncate">also in “{g.title}”</span>
              </Button>
              <Tooltip.Content>
                Another hunk of this file in group “{g.title}”
              </Tooltip.Content>
            </Tooltip>
          );
        })}
        <span className="flex-1" />
        {viewed?.state === 'dismissed' && (
          <Chip size="sm" variant="soft" color="warning" className="shrink-0">
            changed since viewed
          </Chip>
        )}
        {md && (
          <ToggleButtonGroup
            size="sm"
            selectionMode="single"
            disallowEmptySelection
            aria-label="Markdown view"
            className="shrink-0"
            selectedKeys={new Set([preview ? 'preview' : 'code'])}
            onSelectionChange={(k) => setPreview([...k][0] === 'preview')}
          >
            <ToggleButton id="code">Code</ToggleButton>
            <ToggleButton id="preview">
              <ToggleButtonGroup.Separator />
              Preview
            </ToggleButton>
          </ToggleButtonGroup>
        )}
        <ToggleButton
          size="sm"
          isSelected={isViewed}
          onChange={() => setFileViewed(store, pr, file.path, !isViewed)}
          className="viewed-toggle shrink-0 gap-1.5"
          aria-label={local ? 'read' : 'Viewed — syncs with GitHub'}
        >
          {isViewed ? (
            <CircleCheckFill className="size-4 text-success" />
          ) : (
            <Eye className="size-4" />
          )}
          {local ? 'Read' : 'Viewed'}
        </ToggleButton>
      </header>
      {md && preview ? (
        <MarkdownDiff
          pr={pr}
          base={base}
          head={rev}
          path={file.path}
          oldPath={file.old_path}
        />
      ) : collapsedFile ? (
        <div className="collapsed-file flex items-center gap-3 bg-surface-secondary px-4 py-3 text-sm text-muted">
          <span className="flex-1">
            {generatedFlag
              ? `Generated file — ${generatedFlag.reason}`
              : `Whole file deleted: ${plural(file.deletions, 'line', 'lines')}`}
          </span>
          <Button
            size="sm"
            variant="tertiary"
            className="show-file"
            onPress={() => setShown(true)}
          >
            Show diff
          </Button>
        </div>
      ) : (
        <>
          {file.hunks.map((h) => (
            <div key={h.id}>
              {gaps.has(h.id) && (
                <ContextGap
                  pr={pr}
                  rev={rev}
                  path={file.path}
                  gap={gaps.get(h.id)!}
                  lang={lang}
                  expand={expandHunk?.hunk === h.id ? expandHunk.nonce : null}
                />
              )}
              <HunkOrSplit
                pr={pr}
                rev={rev}
                path={file.path}
                h={h}
                lang={lang}
                split={split}
                since={since?.get(h.id)}
                focusHunk={focusHunk}
                setFocusHunk={setFocusHunk}
                composer={composer}
                setComposer={setComposer}
                rangeStart={rangeStart}
                setRangeStart={setRangeStart}
                peek={peek}
                setPeek={setPeek}
              />
            </div>
          ))}
          {last && (
            <FileTail
              pr={pr}
              rev={rev}
              path={file.path}
              hunks={file.hunks}
              lang={lang}
            />
          )}
        </>
      )}
    </Card>
  );
}

function HunkOrSplitInner(
  props: {
    h: Hunk;
    lang: ReturnType<typeof langOf>;
    split: boolean;
    since?: SinceKind;
    focusHunk: HunkId | null;
    setFocusHunk: (h: HunkId | null) => void;
  } & LineProps,
) {
  const { split, ...rest } = props;
  return split ? <SplitHunkView {...rest} /> : <HunkView {...rest} />;
}

function HunkViewInner({
  pr,
  rev,
  path,
  h,
  lang,
  since,
  focusHunk,
  setFocusHunk,
  composer,
  setComposer,
  rangeStart,
  setRangeStart,
  peek,
  setPeek,
}: {
  h: Hunk;
  lang: ReturnType<typeof langOf>;
  since?: SinceKind;
  focusHunk: HunkId | null;
  setFocusHunk: (h: HunkId | null) => void;
} & LineProps) {
  const store = useRootStore();
  const read =
    store.models.hunkReads.where((r) => r.pr === pr && r.hunk === h.id).length >
    0;
  const marks = useMemo(() => wordMarks(h.lines), [h.lines]);
  const focused = focusHunk === h.id;
  const hunkMenu = useContextMenu((): ContextMenuItem[] => [
    {
      id: 'mark-read',
      label: 'Mark read',
      isDisabled: read,
      disabledReason: 'Already read',
      onAction: () => markHunkRead(store, pr, h.id),
    },
    {
      id: 'ask-agent',
      label: 'Ask agent',
      onAction: () =>
        void ask(store, {
          pr,
          question: `about the hunk at ${path}:${h.new_start}`,
          about: null,
          group: null,
          agent: null,
        }).catch(() => {
          // toasted by api.ts
        }),
    },
    {
      id: 'copy-hunk',
      label: 'Copy hunk',
      onAction: () =>
        void navigator.clipboard.writeText(
          h.lines.map((l) => l.text).join('\n'),
        ),
    },
  ]);
  return (
    <div
      id={`H-${h.id}`}
      className={`hunk border-t border-separator first:border-t-0 ${focused ? 'focus ring-2 ring-inset ring-accent' : ''} ${read ? 'read' : ''}`}
      onMouseDown={() => !focused && setFocusHunk(h.id)}
    >
      <div
        className={`flex min-h-8 items-center gap-3 px-4 py-1 text-xs text-muted ${focused ? 'bg-accent-soft/60' : 'bg-surface-secondary'}`}
        onContextMenu={hunkMenu}
      >
        <span className="tabular-nums">{hunkRange(h)}</span>
        {h.header && (
          <span className="min-w-0 flex-1 truncate text-muted/70">
            {h.header}
          </span>
        )}
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
            peek={peek}
            setPeek={setPeek}
          />
        ))}
      </div>
    </div>
  );
}

/** Side-by-side rendering of one hunk, using `splitRows` to pair del/add lines. */
function SplitHunkViewInner({
  pr,
  rev,
  path,
  h,
  lang,
  since,
  focusHunk,
  setFocusHunk,
  composer,
  setComposer,
  rangeStart,
  setRangeStart,
  peek,
  setPeek,
}: {
  h: Hunk;
  lang: ReturnType<typeof langOf>;
  since?: SinceKind;
  focusHunk: HunkId | null;
  setFocusHunk: (h: HunkId | null) => void;
} & LineProps) {
  const store = useRootStore();
  const read =
    store.models.hunkReads.where((r) => r.pr === pr && r.hunk === h.id).length >
    0;
  const marks = useMemo(() => wordMarks(h.lines), [h.lines]);
  const rows = useMemo(() => splitRows(h.lines), [h.lines]);
  const focused = focusHunk === h.id;
  return (
    <div
      id={`H-${h.id}`}
      className={`hunk split border-t border-separator first:border-t-0 ${focused ? 'focus ring-2 ring-inset ring-accent' : ''} ${read ? 'read' : ''}`}
      onMouseDown={() => !focused && setFocusHunk(h.id)}
    >
      <div
        className={`flex min-h-8 items-center gap-3 px-4 py-1 text-xs text-muted ${focused ? 'bg-accent-soft/60' : 'bg-surface-secondary'}`}
      >
        <span className="tabular-nums">{hunkRange(h)}</span>
        {h.header && (
          <span className="min-w-0 flex-1 truncate text-muted/70">
            {h.header}
          </span>
        )}
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
                  peek={peek}
                  setPeek={setPeek}
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
                  peek={peek}
                  setPeek={setPeek}
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
  peek,
  setPeek,
}: {
  l: DiffLine;
  lang: ReturnType<typeof langOf>;
  marks?: [number, number][];
} & LineProps) {
  const store = useRootStore();
  const ui = useUi();
  const anchor = lineAnchor(rev, path, l);
  const prThreads = store.models.prDetails.get(pr)?.threads ?? [];
  const threads = anchor
    ? prThreads.filter(
        (t) =>
          !!t.anchor && sameAnchor(t.anchor, path, anchor.side, anchor.line),
      )
    : [];
  const drafts = anchor
    ? store.models.drafts.where(
        (d) =>
          d.pr === pr && sameAnchor(d.anchor, path, anchor.side, anchor.line),
      )
    : [];
  const findings = anchor
    ? store.models.findings.where(
        (f) =>
          f.pr === pr &&
          f.state !== 'ignored' &&
          sameAnchor(f.anchor, path, anchor.side, anchor.line),
      )
    : [];
  const composing =
    anchor &&
    composer &&
    sameAnchor(anchor, path, composer.side, composer.line);
  const composerAnchor =
    composing && anchor ? lineAnchor(rev, path, l, composer!.startLine) : null;
  const lineNo = l.new_no ?? l.old_no ?? 0;
  const peekHere = !!peek && peek.path === path && peek.line === lineNo;
  const summary = store.models.prSummaries.get(pr);
  const lineMenu = useContextMenu((): ContextMenuItem[] => {
    if (!anchor) return [];
    const items: ContextMenuItem[] = [
      {
        id: 'comment',
        label: 'Comment',
        onAction: () =>
          setComposer({ path, side: anchor.side, line: anchor.line }),
      },
      {
        id: 'comment-range',
        label: 'Start a comment range here',
        onAction: () =>
          setRangeStart({ path, side: anchor.side, line: anchor.line }),
      },
      {
        id: 'ask-agent',
        label: 'Ask agent',
        onAction: () =>
          void ask(store, {
            pr,
            question: `about ${path}:${lineNo}`,
            about: anchor,
            group: null,
            agent: null,
          }).catch(() => {
            // toasted by api.ts
          }),
      },
      {
        id: 'copy-line',
        label: 'Copy line',
        onAction: () => void navigator.clipboard.writeText(l.text),
      },
    ];
    if (summary) {
      items.push({
        id: 'copy-permalink',
        label: 'Copy permalink',
        onAction: () =>
          void navigator.clipboard.writeText(
            `${summary.url}#diff-${path}L${lineNo}`,
          ),
      });
    }
    return items;
  });
  return (
    <>
      <div
        className={`ln t-${l.kind}`}
        onClick={(e) => {
          if (!(e.metaKey || e.ctrlKey)) return;
          const name = symbolAt(e);
          if (!name) return;
          e.preventDefault();
          setPeek({ name, path, line: lineNo });
        }}
        onContextMenu={lineMenu}
      >
        <span className="no">{l.old_no ?? ''}</span>
        <span className="no">{l.new_no ?? ''}</span>
        <span className="mark">
          {findings.length > 0 ? (
            <span
              className={`inline-block size-[9px] cursor-pointer rounded-full ${sevBg[findings[0]!.severity]}`}
              title={findings.map((f) => f.title).join('\n')}
              onClick={() => ui.toggleAside(true)}
            />
          ) : (
            <span>{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}</span>
          )}
        </span>
        <Code s={l.text} lang={lang} marks={marks} />
        <span className="ln-act">
          {anchor && (
            <>
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
                        startLine:
                          startLine !== endLine ? startLine : undefined,
                      });
                    } else {
                      setRangeStart({
                        path,
                        side: anchor.side,
                        line: anchor.line,
                      });
                      setComposer({
                        path,
                        side: anchor.side,
                        line: anchor.line,
                      });
                    }
                  }}
                >
                  <Plus className="size-3" />
                </Button>
                <Tooltip.Content>
                  Comment · shift-click another line for a range
                </Tooltip.Content>
              </Tooltip>
              <Button
                isIconOnly
                size="sm"
                aria-label="ask AI about this line"
                className="h-5 min-w-5 w-5 rounded-xl text-xs"
                onPress={() =>
                  void ask(store, {
                    pr,
                    question: `explain ${path}:${lineNo}`,
                    about: anchor,
                    group: null,
                    agent: null,
                  }).catch(() => {})
                }
              >
                <Sparkles className="size-3" />
              </Button>
            </>
          )}
        </span>
      </div>
      {(threads.length > 0 || drafts.length > 0 || composing || peekHere) && (
        <div className="flex flex-col gap-2 border-y border-separator bg-background py-2 pl-[108px] pr-3 font-sans text-sm">
          {peekHere && peek && (
            <SymbolPeek target={peek} onClose={() => setPeek(null)} />
          )}
          {threads.map((t) => (
            <ThreadView key={t.id} pr={pr} id={t.id} />
          ))}
          {drafts.map((d) => (
            <DraftView key={d.id} d={d} />
          ))}
          {composing && composerAnchor && (
            <Composer
              key={`${composerAnchor.path}:${composerAnchor.start_line}:${composerAnchor.line}`}
              pr={pr}
              anchor={composerAnchor}
              lineText={l.kind !== 'del' ? l.text : ''}
              onClose={() => setComposer(null)}
            />
          )}
        </div>
      )}
    </>
  );
});

const NextGroup = observer(NextGroupInner);
const FileBlock = observer(FileBlockInner);
const HunkOrSplit = observer(HunkOrSplitInner);
const HunkView = observer(HunkViewInner);
const SplitHunkView = observer(SplitHunkViewInner);
