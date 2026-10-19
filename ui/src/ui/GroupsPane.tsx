import { AgentWorking, GroupsSkeleton } from './Loading';
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ArrowRotateRight,
  Check,
  ChevronDown,
  ChevronRight,
  Folder,
  TriangleExclamation,
} from '@gravity-ui/icons';
import {
  Accordion,
  Button,
  Checkbox,
  Chip,
  Label,
  ListBox,
  ListLayout,
  ProgressBar,
  Surface,
  Tabs,
  Tooltip,
  Virtualizer,
} from '@heroui/react';
import { observer } from 'mobx-react-lite';
import type {
  FileDiff,
  FileStatus,
  HunkId,
  PrId,
  Revision,
} from '../gen/contract';
import { ask, markGroupRead, regroup, setFileViewed } from '../actions';
import { useRootStore, useUi } from '../stores/context';
import { contextMenuHandler, type ContextMenuItem } from './ContextMenu';
import type { SinceKind } from './diff';
import { groupsInRevision } from './review/groups';

export interface ReviewMode {
  mode: 'groups' | 'files';
  group: string | null;
  file: string | null;
}

const BIG = 40;

/** Long file lists render through React Aria's Virtualizer: only visible rows hit the DOM. */
function MaybeVirtual({
  count,
  children,
}: {
  count: number;
  children: ReactNode;
}) {
  if (count <= BIG) return <>{children}</>;
  return (
    <Virtualizer layout={ListLayout} layoutOptions={{ rowHeight: 30 }}>
      {children}
    </Virtualizer>
  );
}

const short = (p: string) => p.split('/').slice(-2).join('/');
const base = (p: string) => p.split('/').pop() ?? p;
const circled = (n: number) => '①②③④⑤⑥⑦⑧⑨'[n - 1] ?? String(n);
const plural = (n: number, one: string, few: string, many: string) =>
  `${n} ${n === 1 ? one : n >= 2 && n <= 4 ? few : many}`;

/** Groups loaded for this PR whose hunks are part of the open revision, in
 *  reading order — see the final report on why `Group` needs its own `pr`
 *  field. Exported so Review can drive Tour mode over the same ordering.
 *  Includes `hidden` groups (lockfiles, generated code): they're still
 *  listed here, just collapsed by default in the diff — see
 *  `review/groups.ts`'s `reviewableGroups` for the subset tour/N-P skip. */
export function groupsForRevision(
  store: ReturnType<typeof useRootStore>,
  pr: PrId,
  rev: Revision,
) {
  const hunkIds = new Set(rev.files.flatMap((f) => f.hunks.map((h) => h.id)));
  return groupsInRevision(store.models.groupsOf(pr), hunkIds);
}

/** Per-revision lookups, built once per revision instead of per render:
 *  each hunk's file, each file's hunks (in diff order), and line counts. */
export function hunkIndex(rev: Revision) {
  const hunkFile = new Map<HunkId, string>();
  const hunksOfPath = new Map<string, HunkId[]>();
  const lineStats = new Map<HunkId, { add: number; del: number }>();
  for (const f of rev.files) {
    const ids: HunkId[] = [];
    for (const h of f.hunks) {
      hunkFile.set(h.id, f.path);
      ids.push(h.id);
      let add = 0;
      let del = 0;
      for (const l of h.lines) {
        if (l.kind === 'add') add++;
        else if (l.kind === 'del') del++;
      }
      lineStats.set(h.id, { add, del });
    }
    hunksOfPath.set(f.path, ids);
  }
  return { hunkFile, hunksOfPath, lineStats };
}

export const GroupsPane = observer(function GroupsPane({
  pr,
  rev,
  mode,
  setMode,
  since,
  sinceOnly,
  onTourFrom,
  onOpenFile,
}: {
  pr: PrId;
  rev: Revision;
  mode: ReviewMode;
  setMode: (m: ReviewMode) => void;
  since: Map<HunkId, SinceKind> | null;
  sinceOnly: boolean;
  /** Starts the tour at this group — wired from `Review.tsx`'s own tour state. */
  onTourFrom?: (groupId: string) => void;
  onOpenFile?: (groupId: string, path: string) => void;
}) {
  const store = useRootStore();
  const ui = useUi();
  const summary = store.models.prSummaries.get(pr);
  const local = summary?.pr.repo.host === 'local';
  const groups = groupsForRevision(store, pr, rev);
  const numberOf = new Map(groups.map((g, i) => [g.id, i + 1]));
  const hunkReads = store.models.hunkReads.byPr(pr);
  const readSet = new Set(hunkReads.map((r) => r.hunk));
  const fileViews = store.models.fileViews.byPr(pr);
  const viewedCount = fileViews.filter((v) => v.state === 'viewed').length;

  const { hunkFile, hunksOfPath, lineStats } = useMemo(
    () => hunkIndex(rev),
    [rev],
  );
  const hunkGroup = new Map<HunkId, string>();
  for (const g of groups) for (const h of g.hunks) hunkGroup.set(h, g.id);

  const visibleGroups = groups.filter(
    (g) => !sinceOnly || g.hunks.some((h) => since?.has(h)),
  );

  return (
    <Surface
      variant="secondary"
      className="groups flex min-h-0 flex-col border-r border-separator"
    >
      <div className="mx-4 mb-2 mt-4 flex items-center gap-1">
        <Tabs
          selectedKey={mode.mode}
          onSelectionChange={(k) =>
            setMode({
              mode: k as ReviewMode['mode'],
              group: mode.group,
              file: mode.file ?? rev.files[0]?.path ?? null,
            })
          }
          className="mode-tabs min-w-0 flex-1"
        >
          <Tabs.ListContainer>
            <Tabs.List aria-label="How to show changes" className="w-full">
              <Tabs.Tab
                id="groups"
                className="flex-1 whitespace-nowrap"
                isDisabled={!groups.length}
              >
                Grouped
                <Tabs.Indicator />
              </Tabs.Tab>
              <Tabs.Tab id="files" className="flex-1 whitespace-nowrap">
                <Tabs.Separator />
                Files
                <Tabs.Indicator />
              </Tabs.Tab>
            </Tabs.List>
          </Tabs.ListContainer>
        </Tabs>
        <RegroupButton pr={pr} />
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-2 pb-4">
        {mode.mode === 'groups' && groups.length === 0 && (
          <GroupingStatus status={store.ephemeral.grouping.get(pr)} />
        )}
        {mode.mode === 'groups' ? (
          <Accordion
            expandedKeys={new Set(mode.group ? [mode.group] : [])}
            onExpandedChange={(keys) => {
              const k = [...keys].find((x) => x !== mode.group) ?? [...keys][0];
              if (k !== undefined)
                setMode({ mode: 'groups', group: String(k), file: mode.file });
            }}
            hideSeparator
          >
            {visibleGroups.map((g, gi) => {
              const hs = sinceOnly
                ? g.hunks.filter((h) => since?.has(h))
                : g.hunks;
              const read = hs.filter((h) => readSet.has(h)).length;
              const outFiles = new Set(
                hs
                  .filter((h) => g.outliers.includes(h))
                  .map((h) => hunkFile.get(h)!),
              );
              const files = [...new Set(hs.map((h) => hunkFile.get(h)!))].sort(
                (a, b) => Number(outFiles.has(b)) - Number(outFiles.has(a)),
              );
              const add = hs.reduce(
                (n, h) => n + (lineStats.get(h)?.add ?? 0),
                0,
              );
              const del = hs.reduce(
                (n, h) => n + (lineStats.get(h)?.del ?? 0),
                0,
              );
              const state =
                read === hs.length ? 'done' : read ? 'part' : 'none';
              const sel = mode.group === g.id;
              const n = numberOf.get(g.id)!;
              return (
                <Accordion.Item
                  key={g.id}
                  id={g.id}
                  className={`grp relative ${g.kind !== 'normal' ? 'opacity-70' : ''}`}
                >
                  {gi < visibleGroups.length - 1 && (
                    <span
                      aria-hidden
                      className={`absolute bottom-0 left-[23px] top-9 w-px ${state === 'done' ? 'bg-success' : 'bg-separator'}`}
                    />
                  )}
                  <Accordion.Heading>
                    <Accordion.Trigger
                      className="grp-h flex w-full items-start gap-3 rounded-2xl px-2 py-2 text-left hover:bg-default/50"
                      onContextMenu={contextMenuHandler(
                        ui,
                        (): ContextMenuItem[] => [
                          {
                            id: 'mark-read',
                            label: 'Mark read',
                            isDisabled: read === hs.length,
                            disabledReason: 'Already read',
                            onAction: () => markGroupRead(store, pr, hs),
                          },
                          {
                            id: 'tour-from-here',
                            label: 'Tour from here',
                            isDisabled: !onTourFrom || g.kind === 'hidden',
                            disabledReason:
                              g.kind === 'hidden'
                                ? 'Hidden groups are skipped by the tour'
                                : undefined,
                            onAction: () => onTourFrom?.(g.id),
                          },
                          {
                            id: 'ask-agent',
                            label: 'Ask agent',
                            onAction: () =>
                              void ask(store, {
                                pr,
                                question: `about the "${g.title}" group`,
                                about: null,
                                group: g.id,
                                agent: null,
                              }).catch(() => {
                                // toasted by api.ts
                              }),
                          },
                        ],
                      )}
                    >
                      <span
                        className={`relative z-[1] grid size-[30px] shrink-0 place-items-center rounded-full border text-xs font-semibold tabular-nums ${
                          state === 'done'
                            ? 'border-success bg-success text-success-foreground'
                            : sel
                              ? 'border-accent bg-accent-soft text-accent'
                              : 'border-separator bg-surface text-muted'
                        }`}
                      >
                        {state === 'done' ? <Check className="size-4" /> : n}
                        {state === 'part' && (
                          <svg
                            className="absolute -inset-px size-[30px] -rotate-90"
                            viewBox="0 0 30 30"
                            aria-hidden
                          >
                            <circle
                              cx="15"
                              cy="15"
                              r="14"
                              fill="none"
                              stroke="var(--warning)"
                              strokeWidth="2"
                              strokeDasharray={`${(read / hs.length) * 88} 88`}
                            />
                          </svg>
                        )}
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5 pt-1">
                        <span className="flex items-start gap-1.5">
                          <span
                            className={`gtitle flex-1 text-sm ${sel ? 'font-semibold' : 'font-medium'}`}
                          >
                            {g.title}
                          </span>
                          {g.risk && (
                            <Tooltip>
                              <Tooltip.Trigger>
                                <TriangleExclamation className="mt-0.5 size-3.5 text-warning" />
                              </Tooltip.Trigger>
                              <Tooltip.Content>{g.risk}</Tooltip.Content>
                            </Tooltip>
                          )}
                        </span>
                        <span className="flex items-center gap-2 whitespace-nowrap text-xs text-muted">
                          <span>
                            {plural(files.length, 'file', 'files', 'files')}
                          </span>
                          <span className="tabular-nums">
                            <span className="text-success">+{add}</span>{' '}
                            <span className="text-danger">−{del}</span>
                          </span>
                          {g.kind === 'skim' && <span>skim</span>}
                          {g.kind === 'hidden' && <span>hidden</span>}
                          <span className="ml-auto tabular-nums">
                            {read}/{hs.length}
                          </span>
                        </span>
                      </span>
                    </Accordion.Trigger>
                  </Accordion.Heading>
                  <Accordion.Panel>
                    <Accordion.Body className="py-0 pl-11 pr-0">
                      <MaybeVirtual count={files.length}>
                        <ListBox
                          aria-label={`Files in group ${n}`}
                          selectionMode="none"
                          onAction={(k) => onOpenFile?.(g.id, String(k))}
                          className={`p-0 pb-1.5 ${files.length > BIG ? 'h-72 overflow-auto' : ''}`}
                        >
                          {files.map((f) => {
                            const elsewhere = (hunksOfPath.get(f) ?? []).filter(
                              (h) => hunkGroup.get(h) !== g.id,
                            );
                            const others = [
                              ...new Set(
                                elsewhere.map((h) =>
                                  numberOf.get(hunkGroup.get(h)!),
                                ),
                              ),
                            ].join(', ');
                            return (
                              <ListBox.Item
                                key={f}
                                id={f}
                                textValue={base(f)}
                                className="min-h-6 gap-1.5 px-1.5 py-0.5 text-xs"
                              >
                                <Viewed pr={pr} path={f} local={!!local} />
                                <span
                                  className="min-w-0 flex-1 truncate font-mono"
                                  title={f}
                                >
                                  {short(f)}
                                </span>
                                {outFiles.has(f) && (
                                  <Chip
                                    size="sm"
                                    variant="soft"
                                    color="warning"
                                  >
                                    off-pattern
                                  </Chip>
                                )}
                                {elsewhere.length > 0 && (
                                  <Tooltip>
                                    <Tooltip.Trigger>
                                      <Chip
                                        size="sm"
                                        variant="soft"
                                        color="warning"
                                      >
                                        also in {others}
                                      </Chip>
                                    </Tooltip.Trigger>
                                    <Tooltip.Content>
                                      {plural(
                                        elsewhere.length,
                                        'more hunk',
                                        'more hunks',
                                        'more hunks',
                                      )}{' '}
                                      in {others} — Viewed on GitHub only once
                                      all are read
                                    </Tooltip.Content>
                                  </Tooltip>
                                )}
                              </ListBox.Item>
                            );
                          })}
                        </ListBox>
                      </MaybeVirtual>
                    </Accordion.Body>
                  </Accordion.Panel>
                </Accordion.Item>
              );
            })}
          </Accordion>
        ) : (
          <FileTree
            pr={pr}
            rev={rev}
            local={!!local}
            selected={mode.file}
            hunkGroup={hunkGroup}
            numberOf={numberOf}
            onSelect={(path) =>
              setMode({ mode: 'files', group: mode.group, file: path })
            }
          />
        )}
      </div>

      <div className="groups-foot flex flex-col gap-2 border-t border-separator px-4 py-3 text-xs">
        {local ? (
          <span className="text-muted">
            local: read state is stored only here
          </span>
        ) : (
          <ProgressBar
            aria-label="Viewed on GitHub"
            value={viewedCount}
            maxValue={rev.files.length}
            size="sm"
            color="success"
          >
            <Label className="text-xs">
              Viewed on GitHub: <b>{viewedCount}</b>/{rev.files.length} files
            </Label>
            <ProgressBar.Track>
              <ProgressBar.Fill />
            </ProgressBar.Track>
          </ProgressBar>
        )}
      </div>
    </Surface>
  );
});

const Viewed = observer(function Viewed({
  pr,
  path,
  local,
}: {
  pr: PrId;
  path: string;
  local: boolean;
}) {
  const store = useRootStore();
  const v = store.models.fileViews.of(pr, path);
  const viewed = v?.state === 'viewed';
  return (
    <span className="viewed inline-flex items-center gap-0.5">
      <Checkbox
        aria-label={local ? 'Read' : 'Viewed — synced with GitHub'}
        isSelected={viewed}
        onChange={() => setFileViewed(store, pr, path, !viewed)}
      >
        <Checkbox.Content>
          <Checkbox.Control>
            <Checkbox.Indicator />
          </Checkbox.Control>
        </Checkbox.Content>
      </Checkbox>
      {v?.state === 'dismissed' && (
        <span
          className="font-bold text-warning"
          title="changed after you marked it viewed"
        >
          ↻
        </span>
      )}
    </span>
  );
});

interface Dir {
  path: string;
  name: string;
  dirs: Dir[];
  files: FileDiff[];
}

/** Folders from paths; chains of single folders collapse into one row («src/billing»). */
function buildTree(files: FileDiff[]): Dir {
  const root: Dir = { path: '', name: '', dirs: [], files: [] };
  for (const f of files) {
    const parts = f.path.split('/').slice(0, -1);
    let d = root;
    parts.forEach((p, i) => {
      const path = parts.slice(0, i + 1).join('/');
      let next = d.dirs.find((x) => x.path === path);
      if (!next) {
        next = { path, name: p, dirs: [], files: [] };
        d.dirs.push(next);
      }
      d = next;
    });
    d.files.push(f);
  }
  const squash = (d: Dir): Dir => {
    let cur = { ...d, dirs: d.dirs.map(squash) };
    while (cur.path && cur.dirs.length === 1 && !cur.files.length) {
      const only = cur.dirs[0]!;
      cur = { ...only, name: `${cur.name}/${only.name}` };
    }
    return cur;
  };
  return { ...root, dirs: root.dirs.map(squash) };
}

const allFiles = (d: Dir): FileDiff[] => [
  ...d.files,
  ...d.dirs.flatMap(allFiles),
];

const STATUS: Record<FileStatus, [string, string]> = {
  added: ['A', 'text-success'],
  modified: ['M', 'text-warning'],
  renamed: ['R', 'text-accent'],
  deleted: ['D', 'text-danger'],
  copied: ['C', 'text-accent'],
};

/** "Files" as a tree: folders fold, each shows how much of it is viewed. */
const FileTree = observer(function FileTree({
  pr,
  rev,
  local,
  selected,
  hunkGroup,
  numberOf,
  onSelect,
}: {
  pr: PrId;
  rev: Revision;
  local: boolean;
  selected: string | null;
  hunkGroup: Map<HunkId, string>;
  numberOf: Map<string, number>;
  onSelect: (path: string) => void;
}) {
  const store = useRootStore();
  const fileViews = store.models.fileViews.byPr(pr);
  // First row per path, as `fileViews.find` would pick — once, not per dir.
  const viewOf = new Map<string, (typeof fileViews)[number]>();
  for (const v of fileViews) if (!viewOf.has(v.path)) viewOf.set(v.path, v);
  const files = rev.files;
  const tree = buildTree(files);
  const [closed, setClosed] = useState<Record<string, boolean>>(() =>
    files.length > BIG
      ? Object.fromEntries(
          tree.dirs.flatMap((d) => d.dirs.map((x) => [x.path, true])),
        )
      : {},
  );
  type Row = { key: string; depth: number; dir?: Dir; file?: FileDiff };
  const rows: Row[] = [];
  const walk = (d: Dir, depth: number) => {
    for (const x of d.dirs) {
      rows.push({ key: `dir:${x.path}`, depth, dir: x });
      if (!closed[x.path]) walk(x, depth + 1);
    }
    for (const f of d.files) rows.push({ key: f.path, depth, file: f });
  };
  walk(tree, 0);
  return (
    <MaybeVirtual count={rows.length}>
      <ListBox
        aria-label="Files"
        selectionMode="single"
        selectedKeys={selected ? [selected] : []}
        onSelectionChange={(keys) => {
          const k = keys === 'all' ? undefined : [...keys][0];
          if (k === undefined) return;
          const key = String(k);
          if (key.startsWith('dir:')) {
            const p = key.slice(4);
            setClosed((c) => ({ ...c, [p]: !c[p] }));
          } else onSelect(key);
        }}
        className={`file-tree p-0 ${rows.length > BIG ? 'h-full overflow-auto' : ''}`}
      >
        {rows.map((row) => {
          const pad = { paddingInlineStart: `${6 + row.depth * 14}px` };
          if (row.dir) {
            const fs = allFiles(row.dir);
            const seen = fs.filter(
              (f) => viewOf.get(f.path)?.state === 'viewed',
            ).length;
            return (
              <ListBox.Item
                key={row.key}
                id={row.key}
                textValue={row.dir.name}
                className="tree-dir min-h-7 gap-1.5 pe-1.5 text-xs"
                style={pad}
              >
                {closed[row.dir.path] ? (
                  <ChevronRight className="size-3.5 text-muted" />
                ) : (
                  <ChevronDown className="size-3.5 text-muted" />
                )}
                <Folder className="size-3.5 text-muted" />
                <span className="min-w-0 flex-1 truncate font-mono">
                  {row.dir.name}
                </span>
                <span
                  className={`tabular-nums ${seen === fs.length ? 'text-success' : 'text-muted'}`}
                >
                  {seen}/{fs.length}
                </span>
              </ListBox.Item>
            );
          }
          const f = row.file!;
          const gs = [
            ...new Set(
              f.hunks
                .map((h) => hunkGroup.get(h.id))
                .filter((g): g is string => !!g),
            ),
          ];
          const [letter, color] = STATUS[f.status];
          return (
            <ListBox.Item
              key={row.key}
              id={row.key}
              textValue={f.path}
              className="min-h-7 gap-1.5 pe-1.5 text-xs"
              style={pad}
            >
              <Viewed pr={pr} path={f.path} local={local} />
              <span
                className={`w-3 text-center font-mono font-semibold ${color}`}
                title={f.status}
              >
                {letter}
              </span>
              <span
                className={`min-w-0 flex-1 truncate font-mono ${f.status === 'deleted' ? 'text-muted line-through' : ''}`}
                title={f.old_path ? `${f.old_path} → ${f.path}` : f.path}
              >
                {base(f.path)}
              </span>
              {f.flags.some((fl) => fl.kind === 'generated') && (
                <span className="text-muted">gen</span>
              )}
              {gs.map((g) => (
                <Chip key={g} size="sm" variant="tertiary">
                  {circled(numberOf.get(g) ?? 0)}
                </Chip>
              ))}
            </ListBox.Item>
          );
        })}
      </ListBox>
    </MaybeVirtual>
  );
});

export const groupHunkIds = (
  store: ReturnType<typeof useRootStore>,
  pr: PrId,
  groupId: string,
): HunkId[] =>
  store.models.groupsOf(pr).find((g) => g.id === groupId)?.hunks ?? [];

/** Re-runs grouping from scratch for this PR (spins while it runs). */
const RegroupButton = observer(function RegroupButton({ pr }: { pr: PrId }) {
  const store = useRootStore();
  const running = !!store.ephemeral.grouping.get(pr)?.running;
  return (
    <Tooltip>
      <Button
        isIconOnly
        size="sm"
        variant="ghost"
        aria-label="Regroup"
        className="shrink-0"
        isDisabled={running}
        onPress={() => void regroup(store, pr)}
      >
        <ArrowRotateRight
          className={`size-4 ${running ? 'animate-spin motion-reduce:animate-none' : ''}`}
        />
      </Button>
      <Tooltip.Content>
        {running ? 'Grouping…' : 'Regroup this PR from scratch'}
      </Tooltip.Content>
    </Tooltip>
  );
});

/** Shown while a PR has no grouping yet: running, failed, or not started. */
function GroupingStatus({
  status,
}: {
  status: { running: boolean; error: string | null } | undefined;
}) {
  if (status?.error)
    return (
      <div className="px-4 py-3 text-xs text-danger">
        Grouping failed: {status.error}
      </div>
    );
  return (
    <div className="flex flex-col gap-1 pt-2">
      <div className="px-3">
        <AgentWorking text="Grouping changes by meaning… a few minutes on large PRs" />
      </div>
      <GroupsSkeleton />
    </div>
  );
}
