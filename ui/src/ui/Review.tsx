import { REVIEW_EVENT } from '../core/menu';
import { DiffSkeleton } from './Loading';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ClockArrowRotateLeft,
  CodeMerge,
  Comments as CommentsIcon,
  LayoutRows,
  LayoutSideContentLeft,
  LayoutSideContentRight,
  LayoutSplitColumns,
  Play,
  Stop,
} from '@gravity-ui/icons';
import {
  CircleCheck,
  Code,
  CodeCommit,
  Eye,
  FileText,
} from '@gravity-ui/icons';
import {
  Alert,
  Breadcrumbs,
  Button,
  Chip,
  Disclosure,
  Separator,
  Spinner,
  Tabs,
  ToggleButton,
  ToggleButtonGroup,
  Toolbar,
  Tooltip,
  Typography,
} from '@heroui/react';
import { observer } from 'mobx-react-lite';
import type { HunkId, PrId } from '../gen/contract';
import { api } from '../core/api';
import { markGroupRead, setDraft, setFileViewed } from '../actions';
import { FEATURES } from '../features';
import { Md } from '../highlight';
import { useRootStore, useUi } from '../stores/context';
import { Btn, CheckIcon, Hints, K } from './bits';
import { Checks, Commits, ReviewerPicker, ReviewerStrip } from './Checks';
import {
  DiffPane,
  pendingJump,
  lineAnchor,
  type ComposerState,
} from './DiffPane';
import { sinceHunks, type SinceKind } from './diff';
import { GroupsPane, type ReviewMode } from './GroupsPane';
import { LinearChips } from './linear/LinearChips';
import { MergeDialog } from './Merge';
import {
  groupsInRevision,
  nextReviewableGroup,
  prevReviewableGroup,
  reviewableGroups,
} from './review/groups';
import { hunksInScope, moveHunkFocus } from './review/hunks';
import { tourNextIndex, tourPrevIndex, tourStartIndex } from './review/tour';
import { SidePanel } from './SidePanel';
import { PRIcon, prStatusLabel } from './StatusIcon';
import { latinKey, useViewKeys } from './keys';

type PrTab = 'diff' | 'checks' | 'commits';

const lastSeenKey = (pr: PrId) => `theodore-lastseen:${pr}`;

/** Below this width the groups pane and the aside stop being grid columns —
 *  there isn't room for three panes and a diff column no narrower than
 *  `DIFF_MIN`. Pure, so the breakpoints are unit-testable without mounting
 *  anything. */
const GROUPS_BREAKPOINT = 1060;
const ASIDE_BREAKPOINT = 1280;
export const DIFF_MIN = 520;

export type ReviewLayout = {
  groups: 'column' | 'drawer';
  aside: 'column' | 'drawer';
};

export function layoutFor(width: number): ReviewLayout {
  return {
    groups: width < GROUPS_BREAKPOINT ? 'drawer' : 'column',
    aside: width < ASIDE_BREAKPOINT ? 'drawer' : 'column',
  };
}

/** Tracks an element's rendered width. No-op where `ResizeObserver` doesn't
 *  exist (tests) — callers get one read of `window.innerWidth` and nothing
 *  ever updates, which is fine since nothing in this file is DOM-rendered
 *  under vitest today. */
function useElementWidth(ref: { current: HTMLElement | null }): number {
  const [width, setWidth] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth : ASIDE_BREAKPOINT,
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

function progressOf(store: ReturnType<typeof useRootStore>, pr: PrId): number {
  const reads = store.models.hunkReads.byPr(pr);
  const groups = store.models.groupsOf(pr).filter((g) => g.kind !== 'hidden');
  const hunks = groups.flatMap((g) => g.hunks);
  if (!hunks.length) return 0;
  const readSet = new Set(reads.map((r) => r.hunk));
  return hunks.filter((h) => readSet.has(h)).length / hunks.length;
}

export const Review = observer(function Review({ pr }: { pr: PrId }) {
  const store = useRootStore();
  const ui = useUi();
  const rootRef = useRef<HTMLDivElement>(null);
  const width = useElementWidth(rootRef);
  const layout = layoutFor(width);
  // Groups-pane drawer is page-local — unlike `ui.aside`, which the user may
  // also toggle off at wide widths, this only ever matters once collapsed.
  const [groupsOpen, setGroupsOpen] = useState(false);
  useEffect(() => {
    ui.setAsideIsDrawer(layout.aside === 'drawer');
  }, [ui, layout.aside]);
  useEffect(() => () => ui.setAsideIsDrawer(false), [ui]);
  // Grouped by default — the point of the product; Files is the fallback view.
  const [mode, setMode] = useState<ReviewMode>({
    mode: 'groups',
    group: null,
    file: null,
  });
  const [tab, setTab] = useState<PrTab>('diff');
  // Tour's cursor indexes into `tourGroups` below (reviewable groups only —
  // hidden/mechanical ones are skipped, same as `N`/`P`).
  const [tour, setTour] = useState<number | null>(null);
  const [sinceOnly, setSinceOnly] = useState(false);
  const [baselineSha, setBaselineSha] = useState<string | null>(null);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [draftBusy, setDraftBusy] = useState(false);
  // Keyboard-driven hunk focus, the open comment composer, and a one-shot
  // "expand context" request — owned here so `J`/`K`/`C`/`E` can reach into
  // `DiffPane` without it keeping its own, uncontrollable state.
  const [focusHunk, setFocusHunk] = useState<HunkId | null>(null);
  const [composer, setComposer] = useState<ComposerState | null>(null);
  const [expandHunk, setExpandHunk] = useState<{
    hunk: HunkId;
    nonce: number;
  } | null>(null);
  useEffect(() => {
    void store.sync.openPr(pr);
  }, [store, pr]);

  const summary = store.models.prSummaries.get(pr);
  const detail = store.models.prDetails.get(pr);
  const checks = detail?.checks ?? [];
  const failing = checks.filter((c) => c.status === 'fail').length;
  const pending = checks.filter((c) => c.status === 'pending').length;
  const passed = checks.filter((c) => c.status === 'pass').length;
  const revKey = summary ? `${pr}@${summary.head_sha}` : null;
  const revision = revKey
    ? store.revisions.get(revKey, () =>
        api.getRevision({ pr, head: summary!.head_sha }),
      )
    : null;

  // Note the head you had open last time, before overwriting it with this one.
  useEffect(() => {
    if (!summary) return;
    const key = lastSeenKey(pr);
    const stored = localStorage.getItem(key);
    if (stored && stored !== summary.head_sha) setBaselineSha(stored);
    localStorage.setItem(key, summary.head_sha);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pr, summary?.head_sha]);

  const baselineKey = baselineSha ? `${pr}@${baselineSha}` : null;
  const baselineRevision = baselineKey
    ? store.revisions.get(baselineKey, () =>
        api.getRevision({ pr, head: baselineSha! }),
      )
    : null;
  // Memoized so `DiffPane`/`GroupsPane` (both memoized) see the same map
  // until a revision actually changes — revisions are immutable once loaded.
  const revData = revision?.data;
  const baseData =
    baselineRevision?.status === 'ready' ? baselineRevision.data : undefined;
  const since: Map<string, SinceKind> | null = useMemo(
    () =>
      baseData && revData ? sinceHunks(baseData.files, revData.files) : null,
    [baseData, revData],
  );
  const sinceCount = since?.size ?? 0;

  useEffect(() => {
    if (!mode.file && revision?.data?.files.length) {
      setMode((m) => ({ ...m, file: m.file ?? revision.data!.files[0]!.path }));
    }
  }, [revision?.data, mode.file]);

  // Every group with hunks in this revision, in reading order — includes
  // hidden (lockfile/generated) groups, which `GroupsPane` lists collapsed.
  // Same as `groupsForRevision`, memoized on the grouping row (replaced
  // whenever its groups change) so the tour props keep their identity.
  const grouping = store.models.groupings.get(pr);
  const allGroups = useMemo(() => {
    if (!revData) return [];
    const hunkIds = new Set(
      revData.files.flatMap((f) => f.hunks.map((h) => h.id)),
    );
    return groupsInRevision(grouping?.groups ?? [], hunkIds);
  }, [grouping, revData]);
  const allGroupIds = allGroups.map((g) => g.id).join();
  // The subset tour and `N`/`P` step through — hidden groups are nothing to
  // review, so they're skipped unless opened by hand ("show anyway").
  const tourGroups = useMemo(() => reviewableGroups(allGroups), [allGroups]);
  const tourGroupIds = tourGroups.map((g) => g.id).join();

  const group =
    mode.mode === 'groups' && mode.group
      ? store.models.groupsOf(pr).find((g) => g.id === mode.group)
      : null;
  const groupHunkIds = group ? new Set(group.hunks) : null;

  // Like the prototype: in grouped mode a group is always selected —
  // preferring a reviewable one so a lockfile group is never the default.
  useEffect(() => {
    const first = tourGroups[0] ?? allGroups[0];
    if (mode.mode === 'groups' && !mode.group && first) {
      setMode((m) => ({ ...m, group: first.id }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode.mode, mode.group, allGroupIds, tourGroupIds]);

  // Tour drives group selection; keep `mode` in sync with the tour cursor.
  useEffect(() => {
    if (tour == null) return;
    const g = tourGroups[tour];
    if (g) setMode((m) => ({ ...m, mode: 'groups', group: g.id }));
    else setTour(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tour, tourGroupIds]);

  const startTour = () => {
    const reads = new Set(store.models.hunkReads.byPr(pr).map((r) => r.hunk));
    const allRead = tourGroups.map((g) => g.hunks.every((h) => reads.has(h)));
    setTour(tourStartIndex(allRead));
  };

  // Marks the current tour group read and steps to the next one, ending the
  // tour past the last — shared by the `R` shortcut and the tour bar's
  // "Read, next" button.
  const tourAdvance = useCallback(() => {
    if (tour == null) return;
    const g = tourGroups[tour];
    if (g) markGroupRead(store, pr, g.hunks);
    setTour(tourNextIndex(tour, tourGroups.length));
  }, [tour, tourGroups, store, pr]);
  const tourBack = useCallback(() => {
    if (tour == null) return;
    const prev = tourPrevIndex(tour);
    if (prev != null) setTour(prev);
  }, [tour]);
  const tourState = useMemo(
    () =>
      tour !== null
        ? {
            groups: tourGroups,
            index: tour,
            onBack: tourBack,
            onNext: tourAdvance,
          }
        : null,
    [tour, tourGroups, tourBack, tourAdvance],
  );
  // Clicking a file in a group's file list: open that group and jump to the
  // file's first hunk in it (the jump target is force-mounted by DiffPane).
  const [jumpStart, setJumpStart] = useState(false);
  const [jumpSeq, setJumpSeq] = useState(0);
  const onOpenFile = useCallback(
    (groupId: string, path: string) => {
      const g = allGroups.find((x) => x.id === groupId);
      const file = revision?.data?.files.find((f) => f.path === path);
      const inGroup = g ? new Set(g.hunks) : null;
      const first = file?.hunks.find((h) => !inGroup || inGroup.has(h.id));
      if (first) pendingJump.current = true;
      setMode({ mode: 'groups', group: groupId, file: path });
      if (first) {
        setJumpStart(true);
        setJumpSeq((n) => n + 1);
        setFocusHunk(first.id);
      }
    },
    [allGroups, revision?.data],
  );
  const onTourFrom = useCallback(
    (groupId: string) => {
      const idx = tourGroups.findIndex((g) => g.id === groupId);
      if (idx >= 0) setTour(idx);
    },
    [tourGroups],
  );

  // Review items of the native menu bar (see core/menu.ts).
  useEffect(() => {
    const on = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      if (id === 'view-grouped') setMode((m) => ({ ...m, mode: 'groups' }));
      else if (id === 'view-files') setMode((m) => ({ ...m, mode: 'files' }));
      else if (id === 'view-split') ui.toggleDiffView();
      else if (id === 'tour') {
        if (tour === null) startTour();
        else setTour(null);
      } else if (id === 'mark-group-read') {
        const g = allGroups.find((x) => x.id === mode.group);
        if (g) markGroupRead(store, pr, g.hunks);
      } else if (id === 'ask-agent') {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: '/' }));
      } else if (id === 'open-on-host') {
        const url = summary?.url;
        if (url) window.open(url, '_blank');
      }
    };
    window.addEventListener(REVIEW_EVENT, on);
    return () => window.removeEventListener(REVIEW_EVENT, on);
  });

  useViewKeys(
    ui,
    (e) => {
      const k = latinKey(e);
      if (k === 't') {
        if (tour === null) startTour();
        else setTour(null);
        return;
      }
      if (k === 's') {
        ui.toggleDiffView();
        return;
      }
      if (k === '/') {
        ui.toggleAside(true);
        setTimeout(
          () =>
            (
              document.querySelector(
                '.chat-input textarea',
              ) as HTMLTextAreaElement | null
            )?.focus(),
          30,
        );
        return;
      }
      if (k === 'Escape') {
        if (composer) {
          setComposer(null);
          return;
        }
        if (tour !== null) {
          setTour(null);
          return;
        }
        ui.goBack();
        return;
      }
      if (k === 'r') {
        if (tour == null) return false;
        tourAdvance();
        return;
      }
      // The rest only make sense over the diff itself.
      if (tab !== 'diff' || !revision?.data) return false;
      switch (k) {
        case 'j':
        case 'k': {
          const hunks = hunksInScope(revision.data, mode, groupHunkIds);
          const next = moveHunkFocus(hunks, focusHunk, k === 'j' ? 1 : -1);
          if (next) setFocusHunk(next);
          return;
        }
        case 'n':
        case 'p': {
          const next =
            k === 'n'
              ? nextReviewableGroup(allGroups, mode.group)
              : prevReviewableGroup(allGroups, mode.group);
          if (next) setMode((m) => ({ ...m, mode: 'groups', group: next.id }));
          return;
        }
        case 'v': {
          if (!focusHunk) return false;
          const file = revision.data.files.find((f) =>
            f.hunks.some((h) => h.id === focusHunk),
          );
          if (!file) return false;
          const viewed = store.models.fileViews.of(pr, file.path);
          void setFileViewed(store, pr, file.path, viewed?.state !== 'viewed');
          return;
        }
        case 'c': {
          if (!focusHunk) return false;
          const file = revision.data.files.find((f) =>
            f.hunks.some((h) => h.id === focusHunk),
          );
          const hunk = file?.hunks.find((h) => h.id === focusHunk);
          if (!file || !hunk) return false;
          const idx = Math.max(
            0,
            hunk.lines.findIndex((l) => l.kind !== 'ctx'),
          );
          const line = hunk.lines[idx];
          const anchor =
            line && lineAnchor(revision.data.head, file.path, line);
          if (anchor) {
            setComposer({
              path: file.path,
              side: anchor.side,
              line: anchor.line,
            });
          }
          return;
        }
        case 'e': {
          if (!focusHunk) return false;
          setExpandHunk({ hunk: focusHunk, nonce: Date.now() });
          return;
        }
        default:
          return false;
      }
    },
    [
      tour,
      tourGroupIds,
      allGroupIds,
      pr,
      tab,
      mode.mode,
      mode.group,
      mode.file,
      focusHunk,
      composer,
      revision?.data,
      groupHunkIds,
    ],
  );

  // Keep the keyboard-focused hunk in view, same id `DiffPane` renders it
  // under (`H-<hunkId>`).
  useEffect(() => {
    if (!focusHunk) return;
    const target = () => document.getElementById(`H-${focusHunk}`);
    if (!jumpStart) {
      // J/K: a small step, smooth is fine and nothing above it moves.
      const id = requestAnimationFrame(() =>
        target()?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }),
      );
      return () => cancelAnimationFrame(id);
    }
    // A jump (file click, group switch): files above the target mount as
    // they come near the viewport and grow from their placeholder height,
    // which moves the target after a smooth scroll has aimed at it. Jump
    // instantly, then re-aim until the layout settles.
    setJumpStart(false);
    const timers = [0, 80, 200, 400, 700].map((ms) =>
      setTimeout(
        () =>
          // The file card, so its name is in view, not just the hunk.
          (target()?.closest('.file') ?? target())?.scrollIntoView({
            block: 'start',
            behavior: 'auto',
          }),
        ms,
      ),
    );
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusHunk, jumpSeq]);

  const unresolved = (detail?.threads ?? []).filter((t) => !t.resolved).length;
  const local = summary?.pr.repo.host === 'local';
  const mine =
    !!summary && store.ephemeral.viewer?.login === summary.author.login;
  const mergeBlock = !summary
    ? ''
    : local
      ? 'local branch'
      : failing
        ? `${failing} ${failing === 1 ? 'check' : 'checks'} failing`
        : summary.approvals < (summary.required_approvals ?? 0)
          ? `approvals ${summary.approvals}/${summary.required_approvals}`
          : '';

  return (
    <div ref={rootRef} className="review flex min-w-0 flex-1 flex-col">
      <Toolbar
        aria-label="PR"
        className="flex w-full flex-wrap items-center gap-3 border-b border-separator px-4 py-2.5"
      >
        <Tooltip>
          <Button
            isIconOnly
            size="sm"
            variant="ghost"
            aria-label="Back"
            onPress={() => ui.goBack()}
          >
            <ArrowLeft className="size-4" />
          </Button>
          <Tooltip.Content>
            Back <K>Esc</K>
          </Tooltip.Content>
        </Tooltip>
        {layout.groups === 'drawer' && (
          <Tooltip>
            <ToggleButton
              isIconOnly
              size="sm"
              isSelected={groupsOpen}
              onChange={setGroupsOpen}
              aria-label="Files and groups"
            >
              <LayoutSideContentLeft className="size-4" />
            </ToggleButton>
            <Tooltip.Content>
              {groupsOpen ? 'Hide' : 'Show'} files and groups
            </Tooltip.Content>
          </Tooltip>
        )}
        <div className="rv-title flex min-w-0 flex-1 items-center gap-3">
          {summary ? (
            <>
              <Breadcrumbs className="shrink-0 text-sm">
                <Breadcrumbs.Item onPress={() => ui.goBack()}>
                  {summary.pr.repo.owner}/{summary.pr.repo.name}
                </Breadcrumbs.Item>
                <Breadcrumbs.Item>#{summary.pr.number}</Breadcrumbs.Item>
              </Breadcrumbs>
              <Typography.Heading level={6} className="min-w-0 flex-1 truncate">
                {summary.title}
              </Typography.Heading>
              <Chip size="sm" variant="secondary" className="shrink-0 gap-1.5">
                <PRIcon
                  status={summary.state}
                  progress={progressOf(store, pr)}
                />
                {prStatusLabel[summary.state]}
              </Chip>
              {detail?.labels.map((l) => (
                <Chip key={l} size="sm" variant="tertiary" className="shrink-0">
                  {l}
                </Chip>
              ))}
              {FEATURES.linear && <LinearChips pr={pr} />}
            </>
          ) : (
            <Spinner size="sm" />
          )}
        </div>
        <ToggleButton
          size="sm"
          className="gap-1.5"
          isSelected={tour !== null}
          onChange={() => (tour === null ? startTour() : setTour(null))}
        >
          {tour === null ? (
            <Play className="size-4" />
          ) : (
            <Stop className="size-4" />
          )}
          Tour
          <K>T</K>
        </ToggleButton>
        {!local && mine && summary && (
          <Btn
            tone="tertiary"
            icon={summary.state === 'draft' ? <Eye /> : <FileText />}
            isPending={draftBusy}
            onPress={() => {
              setDraftBusy(true);
              void setDraft(store, {
                pr,
                draft: summary.state !== 'draft',
              }).finally(() => setDraftBusy(false));
            }}
          >
            {summary.state === 'draft'
              ? 'Ready for review'
              : 'Convert to draft'}
          </Btn>
        )}
        <Btn tone="primary" onPress={() => ui.openModal('submit')}>
          Submit review
        </Btn>
        {!local && FEATURES.hostWrites && <ReviewerPicker pr={pr} />}
        {!local && (
          <Tooltip>
            <Btn
              tone={mergeBlock ? 'tertiary' : 'success'}
              icon={<CodeMerge />}
              className="merge-btn"
              isDisabled={!FEATURES.hostWrites}
              onPress={() => setMergeOpen(true)}
            >
              Merge
            </Btn>
            <Tooltip.Content>
              {!FEATURES.hostWrites
                ? 'Not available yet'
                : mergeBlock
                  ? `Blocked: ${mergeBlock} — you can enable auto-merge`
                  : 'Merge'}
            </Tooltip.Content>
          </Tooltip>
        )}
        <Tooltip>
          <ToggleButton
            isIconOnly
            size="sm"
            isSelected={ui.asideShown}
            onChange={(v) => ui.toggleAside(v)}
            aria-label="AI panel"
          >
            <LayoutSideContentRight className="size-4" />
          </ToggleButton>
          <Tooltip.Content>
            {ui.asideShown ? 'Hide' : 'Show'} AI, tasks and threads <K>]</K>
          </Tooltip.Content>
        </Tooltip>
      </Toolbar>

      <Toolbar
        aria-label="Sections and people"
        className="flex w-full flex-wrap items-center gap-4 border-b border-separator px-4 py-2"
      >
        <Tabs
          data-plain
          selectedKey={tab}
          onSelectionChange={(k) => setTab(k as PrTab)}
          className="rv-tabs"
        >
          <Tabs.ListContainer>
            <Tabs.List aria-label="PR sections">
              <Tabs.Tab id="diff" className="gap-1.5">
                <Code className="size-4" />
                Code
                <Tabs.Indicator />
              </Tabs.Tab>
              {!local && (
                <Tabs.Tab id="checks" className="gap-1.5">
                  <CheckIcon
                    s={failing ? 'fail' : pending ? 'pending' : 'pass'}
                  />
                  Checks
                  <span className="tabular-nums text-muted">
                    {passed}/{checks.length}
                  </span>
                  <Tabs.Indicator />
                </Tabs.Tab>
              )}
              <Tabs.Tab id="commits" className="gap-1.5">
                <CodeCommit className="size-4" />
                Commits
                <span className="tabular-nums text-muted">
                  {detail?.commits.length ?? 0}
                </span>
                <Tabs.Indicator />
              </Tabs.Tab>
            </Tabs.List>
          </Tabs.ListContainer>
        </Tabs>
        {baselineRevision?.status === 'ready' && (
          <ToggleButtonGroup
            size="sm"
            selectionMode="single"
            disallowEmptySelection
            selectedKeys={new Set([sinceOnly ? 'since' : 'all'])}
            onSelectionChange={(k) => setSinceOnly([...k][0] === 'since')}
            aria-label="What to show"
          >
            <ToggleButton id="all">Whole PR</ToggleButton>
            <ToggleButton id="since" className="gap-1.5">
              <ToggleButtonGroup.Separator />
              <ClockArrowRotateLeft className="size-4" />
              Since last visit
              <span className="tabular-nums text-muted">{sinceCount}</span>
            </ToggleButton>
          </ToggleButtonGroup>
        )}
        {tab === 'diff' && (
          <ToggleButtonGroup
            size="sm"
            selectionMode="single"
            disallowEmptySelection
            selectedKeys={new Set([ui.diffView])}
            onSelectionChange={(k) =>
              [...k][0] !== ui.diffView && ui.toggleDiffView()
            }
            aria-label="Diff view"
          >
            <ToggleButton id="unified" isIconOnly aria-label="Unified">
              <LayoutRows className="size-4" />
            </ToggleButton>
            <ToggleButton id="split" isIconOnly aria-label="Side by side">
              <ToggleButtonGroup.Separator />
              <LayoutSplitColumns className="size-4" />
            </ToggleButton>
          </ToggleButtonGroup>
        )}
        <span className="flex-1" />
        {!local && detail && detail.reviewers.length > 0 && (
          <>
            <ReviewerStrip reviewers={detail.reviewers} />
            <Separator orientation="vertical" className="h-5" />
          </>
        )}
        {summary && (
          <Tooltip>
            <Chip
              size="sm"
              variant="soft"
              color={
                summary.approvals >= (summary.required_approvals ?? 0)
                  ? 'success'
                  : 'default'
              }
              className="approvals shrink-0 gap-1.5 tabular-nums"
            >
              <CircleCheck className="size-3.5" />
              {summary.required_approvals != null
                ? `${summary.approvals}/${summary.required_approvals}`
                : summary.approvals}
            </Chip>
            <Tooltip.Content>
              {summary.required_approvals != null
                ? `Requires ${summary.required_approvals} approval${summary.required_approvals === 1 ? '' : 's'}`
                : 'No required approvals'}
            </Tooltip.Content>
          </Tooltip>
        )}
      </Toolbar>

      {unresolved > 0 && (
        <div className="flex items-center gap-2 border-b border-separator px-4 py-1.5 text-xs text-warning">
          <CommentsIcon className="size-3.5" />
          {unresolved} unresolved thread{unresolved === 1 ? '' : 's'}
        </div>
      )}

      {sinceOnly &&
        sinceCount === 0 &&
        baselineRevision?.status === 'ready' && (
          <Alert
            status="accent"
            className="since-banner rounded-none border-b border-separator px-3 py-1.5"
          >
            <Alert.Indicator>
              <ClockArrowRotateLeft className="size-4" />
            </Alert.Indicator>
            <Alert.Content>
              <Alert.Title>Nothing changed since your last visit.</Alert.Title>
            </Alert.Content>
            <Btn tone="tertiary" onPress={() => setSinceOnly(false)}>
              Whole PR
            </Btn>
          </Alert>
        )}

      {detail?.body && (
        <Disclosure className="description border-b border-separator px-4">
          <Disclosure.Heading>
            <Disclosure.Trigger className="flex items-center gap-1.5 py-2 text-sm text-muted">
              Description
              <Disclosure.Indicator />
            </Disclosure.Trigger>
          </Disclosure.Heading>
          <Disclosure.Content>
            <Disclosure.Body className="max-h-[40vh] max-w-[78ch] overflow-y-auto pb-3">
              <Md text={detail.body} />
            </Disclosure.Body>
          </Disclosure.Content>
        </Disclosure>
      )}

      {!revision || revision.status === 'loading' ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          <DiffSkeleton />
        </div>
      ) : revision.status === 'error' ? (
        <div className="flex flex-1 items-center justify-center text-sm text-danger">
          {revision.error}
        </div>
      ) : (
        (() => {
          const showGroupsColumn = layout.groups === 'column';
          const showAsideColumn = layout.aside === 'column' && ui.aside;
          const gridColsClass = showGroupsColumn
            ? showAsideColumn
              ? 'grid-cols-[256px_minmax(520px,1fr)_352px]'
              : 'grid-cols-[256px_minmax(520px,1fr)]'
            : showAsideColumn
              ? 'grid-cols-[minmax(520px,1fr)_352px]'
              : 'grid-cols-[minmax(520px,1fr)]';
          return (
            <div
              className={`relative grid min-h-0 flex-1 overflow-hidden ${gridColsClass}`}
            >
              {showGroupsColumn && (
                <GroupsPane
                  pr={pr}
                  rev={revision.data!}
                  mode={mode}
                  setMode={setMode}
                  since={since}
                  sinceOnly={sinceOnly && sinceCount > 0}
                  onTourFrom={onTourFrom}
                  onOpenFile={onOpenFile}
                />
              )}
              {tab === 'checks' ? (
                <Checks pr={pr} checks={checks} />
              ) : tab === 'commits' ? (
                <Commits commits={detail?.commits ?? []} />
              ) : (
                <DiffPane
                  pr={pr}
                  rev={revision.data!}
                  mode={mode}
                  setMode={setMode}
                  since={since}
                  sinceOnly={sinceOnly && sinceCount > 0}
                  baselineSha={baselineSha}
                  tour={tourState}
                  focusHunk={focusHunk}
                  setFocusHunk={setFocusHunk}
                  composer={composer}
                  setComposer={setComposer}
                  expandHunk={expandHunk}
                />
              )}
              {showAsideColumn && <SidePanel pr={pr} />}
              {!showGroupsColumn && groupsOpen && (
                <>
                  {/* `grid` (not `flex`/`block`): a single-child grid cell
                   *  stretches that child to fill both axes by default, the
                   *  same way `GroupsPane`'s `Surface` fills its slot as a
                   *  grid column above — no height to hand it otherwise. */}
                  <div className="absolute inset-y-0 left-0 z-20 grid w-64 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)] border-r border-separator bg-background shadow-xl">
                    <GroupsPane
                      pr={pr}
                      rev={revision.data!}
                      mode={mode}
                      setMode={setMode}
                      since={since}
                      sinceOnly={sinceOnly && sinceCount > 0}
                      onTourFrom={onTourFrom}
                      onOpenFile={onOpenFile}
                    />
                  </div>
                  <div
                    className="absolute inset-0 z-10 bg-black/40"
                    onClick={() => setGroupsOpen(false)}
                  />
                </>
              )}
              {!showAsideColumn &&
                layout.aside === 'drawer' &&
                ui.asideShown && (
                  <>
                    <div className="absolute inset-y-0 right-0 z-20 grid w-[352px] max-w-[85vw] grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)] border-l border-separator bg-background shadow-xl">
                      <SidePanel pr={pr} />
                    </div>
                    <div
                      className="absolute inset-0 z-10 bg-black/40"
                      onClick={() => ui.toggleAside(false)}
                    />
                  </>
                )}
            </div>
          );
        })()
      )}
      {tab === 'diff' && (
        <Hints>
          <K>J</K>
          <K>K</K> hunk <K>N</K>
          <K>P</K> group <K>V</K> viewed <K>C</K> comment <K>E</K> context{' '}
          <K>T</K> tour <K>S</K> split <K>/</K> ask AI <K>]</K> AI panel{' '}
          <K>Esc</K> back
        </Hints>
      )}
      {mergeOpen && (
        <MergeDialog
          pr={pr}
          onClose={() => setMergeOpen(false)}
          onOpenFile={(path) => {
            setMergeOpen(false);
            setTab('diff');
            setMode({ mode: 'files', group: mode.group, file: path });
          }}
        />
      )}
    </div>
  );
});
