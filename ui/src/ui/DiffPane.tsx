import { useEffect, useMemo, useState } from 'react';
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
  Kbd,
  Surface,
  ToggleButton,
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
  splitRows,
  wordMarks,
  type Gap,
  type SinceKind,
} from './diff';
import { groupsForRevision, type ReviewMode } from './GroupsPane';
import { SymbolPeek, type SymbolPeekTarget } from './SymbolPeek';

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

export const DiffPane = observer(function DiffPane({
  pr,
  rev,
  mode,
  setMode,
  since,
  sinceOnly,
  tour,
}: {
  pr: PrId;
  rev: Revision;
  mode: ReviewMode;
  setMode: (m: ReviewMode) => void;
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
  const [limit, setLimit] = useState(CHUNK);
  const [focusHunk, setFocusHunk] = useState<HunkId | null>(null);
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

  // A chunked file list resets whenever the group/file/mode changes under it.
  useEffect(() => setLimit(CHUNK), [mode.mode, mode.group, mode.file]);
  const visibleFiles = files.slice(0, limit);

  const totalInGroup =
    mode.mode === 'groups' && groupHunkIds
      ? rev.files.flatMap((f) => f.hunks.filter((h) => groupHunkIds.has(h.id)))
          .length
      : 0;

  return (
    <main className="diff min-w-0 overflow-auto bg-background px-6 pb-20 pt-5">
      {tour && (
        <Surface className="tour sticky -top-5 z-[3] -mx-6 -mt-5 mb-5 flex items-center gap-3 border-b border-separator px-6 py-3">
          <Sparkles className="size-4 text-accent" />
          Tour mode — press <Kbd className="font-mono">R</Kbd> to mark this
          group read and continue
        </Surface>
      )}
      {sinceOnly && (
        <Alert status="accent" className="since-banner mb-4">
          <Alert.Content>
            <Alert.Title>
              Showing only what changed since your last visit.
            </Alert.Title>
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
      {visibleFiles.map((f) => (
        <FileBlock
          key={f.path}
          pr={pr}
          rev={rev.head}
          allFiles={rev.files}
          file={f}
          since={since}
          groupHunkIds={mode.mode === 'groups' ? groupHunkIds : null}
          mode={mode}
          setMode={setMode}
          composer={composer}
          setComposer={setComposer}
          rangeStart={rangeStart}
          setRangeStart={setRangeStart}
          focusHunk={focusHunk}
          setFocusHunk={setFocusHunk}
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
      <div className="flex justify-center py-4">
        {mode.mode === 'groups' && !tour && (
          <NextGroup rev={rev} mode={mode} setMode={setMode} />
        )}
      </div>
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
  const [checked, setChecked] = useState<Record<string, boolean>>({});
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
        <Typography.Heading level={5}>{g.title}</Typography.Heading>
        {g.risk && (
          <Chip size="sm" variant="soft" color="warning" className="gap-1">
            <TriangleExclamation className="size-3.5" />
            {g.risk}
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
              onChange={() =>
                setChecked((s) => ({ ...s, [c]: !s[c] }))
              }
            >
              <Checkbox.Content
                className={checked[c] ? 'text-muted line-through' : ''}
              >
                <Checkbox.Control>
                  <Checkbox.Indicator />
                </Checkbox.Control>
                {c}
              </Checkbox.Content>
            </Checkbox>
          ))}
        </div>
      )}
    </Card>
  );
});

function NextGroup({
  rev,
  mode,
  setMode,
}: {
  rev: Revision;
  mode: ReviewMode;
  setMode: (m: ReviewMode) => void;
}) {
  const store = useRootStore();
  const groups = groupsForRevision(store, rev);
  const next = groups[groups.findIndex((g) => g.id === mode.group) + 1];
  if (!next) return null;
  return (
    <Btn
      icon={<ArrowRight />}
      onPress={() => setMode({ mode: 'groups', group: next.id, file: mode.file })}
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
}: {
  pr: PrId;
  rev: Revision['head'];
  path: string;
  gap: Gap;
  lang: ReturnType<typeof langOf>;
}) {
  const store = useRootStore();
  const [shown, setShown] = useState(0);
  const total = gap.to - gap.from + 1;
  const key = `${pr}@${rev}:${path}`;
  const res = shown > 0 ? store.files.get(key, () => api.getFile({ pr, rev, path })) : null;
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
  const res = shown > 0 ? store.files.get(key, () => api.getFile({ pr, rev, path })) : null;
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

function FileBlock({
  pr,
  rev,
  allFiles,
  file,
  since,
  groupHunkIds,
  mode,
  setMode,
  composer,
  setComposer,
  rangeStart,
  setRangeStart,
  focusHunk,
  setFocusHunk,
  peek,
  setPeek,
}: {
  pr: PrId;
  rev: Revision['head'];
  allFiles: FileDiff[];
  file: FileDiff;
  since?: Map<HunkId, SinceKind> | null;
  groupHunkIds: Set<HunkId> | null;
  mode: ReviewMode;
  setMode: (m: ReviewMode) => void;
  focusHunk: HunkId | null;
  setFocusHunk: (h: HunkId | null) => void;
} & Omit<LineProps, 'path'>) {
  const store = useRootStore();
  const lang = langOf(file.path);
  const viewed = store.models.fileViews
    .where((v) => v.pr === pr && v.path === file.path)
    .at(-1);
  const isViewed = viewed?.state === 'viewed';
  const local =
    store.models.prSummaries.get(pr)?.pr.repo.host === 'local';
  const [shown, setShown] = useState(false);
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

  const collapsedFile = (!!generatedFlag || file.status === 'deleted') && !shown;
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
        <span className="min-w-0 truncate font-mono text-[13px]">
          {file.old_path && (
            <span className="text-muted line-through decoration-muted/60">
              {file.old_path}
            </span>
          )}
          {file.old_path && <span className="px-1.5 text-muted">→</span>}
          <span className="font-medium">{file.path}</span>
        </span>
        {file.status === 'added' && (
          <Chip size="sm" variant="soft" color="success">
            new file
          </Chip>
        )}
        {file.status === 'renamed' && (
          <Chip size="sm" variant="soft" color="accent" className="renamed">
            renamed
            {file.similarity != null ? ` · ${file.similarity}% similar` : ''}
          </Chip>
        )}
        {file.status === 'deleted' && (
          <Chip size="sm" variant="soft" color="danger">
            deleted
          </Chip>
        )}
        {generatedFlag && (
          <Chip size="sm" variant="secondary" className="generated">
            generated · {generatedFlag.reason}
          </Chip>
        )}
        <span className="shrink-0 whitespace-nowrap text-xs tabular-nums">
          <span className="text-success">+{file.additions}</span>{' '}
          <span className="text-danger">−{file.deletions}</span>
        </span>
        {others.map((h) => {
          const g = store.models.groups.all().find((x) => x.hunks.includes(h.id));
          if (!g) return null;
          return (
            <Tooltip key={h.id}>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 gap-1 px-2 text-xs text-accent"
                onPress={() =>
                  setMode({ mode: 'groups', group: g.id, file: file.path })
                }
              >
                also in “{g.title}”
              </Button>
              <Tooltip.Content>
                Another hunk of this file in group “{g.title}”
              </Tooltip.Content>
            </Tooltip>
          );
        })}
        <span className="flex-1" />
        {viewed?.state === 'dismissed' && (
          <Chip size="sm" variant="soft" color="warning">
            changed since viewed
          </Chip>
        )}
        <ToggleButton
          size="sm"
          isSelected={isViewed}
          onChange={() => setFileViewed(store, pr, file.path, !isViewed)}
          className="viewed-toggle gap-1.5"
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
      {collapsedFile ? (
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
                />
              )}
              <HunkOrSplit
                pr={pr}
                rev={rev}
                path={file.path}
                h={h}
                lang={lang}
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
            <FileTail pr={pr} rev={rev} path={file.path} hunks={file.hunks} lang={lang} />
          )}
        </>
      )}
    </Card>
  );
}

function HunkOrSplit(
  props: {
    h: Hunk;
    lang: ReturnType<typeof langOf>;
    since?: SinceKind;
    focusHunk: HunkId | null;
    setFocusHunk: (h: HunkId | null) => void;
  } & LineProps,
) {
  const ui = useUi();
  return ui.diffView === 'split' ? (
    <SplitHunkView {...props} />
  ) : (
    <HunkView {...props} />
  );
}

function HunkView({
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
        void navigator.clipboard.writeText(h.lines.map((l) => l.text).join('\n')),
    },
  ]);
  return (
    <div
      className={`hunk border-t border-separator first:border-t-0 ${focused ? 'focus' : ''} ${read ? 'read' : ''}`}
      onMouseDown={() => !focused && setFocusHunk(h.id)}
    >
      <div
        className={`flex min-h-8 items-center gap-3 px-4 py-1 text-xs text-muted ${focused ? 'bg-accent-soft/60' : 'bg-surface-secondary'}`}
        onContextMenu={hunkMenu}
      >
        <span className="tabular-nums">{hunkRange(h)}</span>
        {h.header && <span className="truncate text-muted/70">{h.header}</span>}
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
function SplitHunkView({
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
      className={`hunk split border-t border-separator first:border-t-0 ${focused ? 'focus' : ''} ${read ? 'read' : ''}`}
      onMouseDown={() => !focused && setFocusHunk(h.id)}
    >
      <div
        className={`flex min-h-8 items-center gap-3 px-4 py-1 text-xs text-muted ${focused ? 'bg-accent-soft/60' : 'bg-surface-secondary'}`}
      >
        <span className="tabular-nums">{hunkRange(h)}</span>
        {h.header && <span className="truncate text-muted/70">{h.header}</span>}
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
        (d) => d.pr === pr && sameAnchor(d.anchor, path, anchor.side, anchor.line),
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
        onAction: () => setComposer({ path, side: anchor.side, line: anchor.line }),
      },
      {
        id: 'comment-range',
        label: 'Comment on range',
        onAction: () => setRangeStart({ path, side: anchor.side, line: anchor.line }),
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
          void navigator.clipboard.writeText(`${summary.url}#diff-${path}L${lineNo}`),
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
