import { openExternal } from '../core/openExternal';
import { useElementWidth } from './useElementWidth';
import { REVIEW_EVENT } from '../core/menu';
import { DiffSkeleton } from './Loading';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ClockArrowRotateLeft,
  CodeMerge,
  Comments as CommentsIcon,
  LayoutRows,
  LayoutSideContentLeft,
  LayoutSideContentRight,
  LayoutSplitColumns,
  Xmark,
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
  Chip,
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
import { useRootStore, useUi } from '../stores/context';
import { Btn, CheckIcon, Hints, K } from './bits';
import { Checks, Commits, ReviewerPicker, ReviewerStrip } from './Checks';
import {
  DiffPane,
  pendingJump,
  lineAnchor,
  type ComposerState,
} from './DiffPane';
import { STORAGE_NS } from '../stores/UiStore';
import { sinceHunks, type SinceKind } from './diff';
import { GroupsPane, type ReviewMode } from './GroupsPane';
import { LinearChips } from './linear/LinearChips';
import { MergeDialog } from './Merge';
import { Overview } from './review/Overview';
import { closeBranchReview } from './project/closeReview';
import { isBranchReview } from './project/sections';
import { reviewTitle } from './space/mode';
import {
  groupsInRevision,
  nextReviewableGroup,
  nextUnreadGroup,
  prevReviewableGroup,
  reviewableGroups,
} from './review/groups';
import { hunksInScope, moveHunkFocus } from './review/hunks';
import { SidePanel } from './SidePanel';
import { PRIcon, prStatusLabel } from './StatusIcon';
import { latinKey, useViewKeys } from './keys';

type PrTab = 'overview' | 'diff' | 'checks' | 'commits';

const lastSeenKey = (pr: PrId) => `${STORAGE_NS}theodore-lastseen:${pr}`;

/** Below this width the groups pane and the aside stop being grid columns —
 *  there isn't room for three panes and a diff column no narrower than
 *  `DIFF_MIN`. Pure, so the breakpoints are unit-testable without mounting
 *  anything. */
const GROUPS_BREAKPOINT = 1060;
const ASIDE_BREAKPOINT = 1280;
/** Below this the header's buttons go icon-only and the breadcrumb drops
 *  the repo, so the title keeps some room (the tab carries it anyway). */
const HEADER_BREAKPOINT = 820;
export const DIFF_MIN = 520;

export type ReviewLayout = {
  groups: 'column' | 'drawer';
  aside: 'column' | 'drawer';
  header: 'full' | 'compact';
};

export function layoutFor(width: number): ReviewLayout {
  return {
    groups: width < GROUPS_BREAKPOINT ? 'drawer' : 'column',
    aside: width < ASIDE_BREAKPOINT ? 'drawer' : 'column',
    header: width < HEADER_BREAKPOINT ? 'compact' : 'full',
  };
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
  const width = useElementWidth(rootRef, ASIDE_BREAKPOINT);
  const layout = layoutFor(width);
  const compact = layout.header === 'compact';
  // Groups-pane drawer is page-local — unlike `ui.aside`, which the user may
  // also toggle off at wide widths, this only ever matters once collapsed.
  const [groupsOpen, setGroupsOpen] = useState(false);
  useEffect(() => {
    ui.setAsideIsDrawer(layout.aside === 'drawer');
  }, [ui, layout.aside]);
  useEffect(() => () => ui.setAsideIsDrawer(false), [ui]);
  // Grouped by default — the point of the product; Files is the fallback view.
  // Reopening a PR (or switching back to its workspace) resumes where it was.
  const [mode, setMode] = useState<ReviewMode>(() => {
    const at = ui.reviewPos[pr];
    return at
      ? { mode: at.mode, group: at.group, file: at.file }
      : { mode: 'groups', group: null, file: null };
  });
  useEffect(() => ui.setReviewPos(pr, mode), [ui, pr, mode]);
  const [tab, setTab] = useState<PrTab>('diff');
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
  // whenever its groups change) so dependents keep their identity.
  const grouping = store.models.groupings.get(pr);
  const allGroups = useMemo(() => {
    if (!revData) return [];
    const hunkIds = new Set(
      revData.files.flatMap((f) => f.hunks.map((h) => h.id)),
    );
    return groupsInRevision(grouping?.groups ?? [], hunkIds);
  }, [grouping, revData]);
  const allGroupIds = allGroups.map((g) => g.id).join();
  // The subset `N`/`P` step through — hidden groups are nothing to review,
  // so they're skipped unless opened by hand ("show anyway").
  const reviewable = useMemo(() => reviewableGroups(allGroups), [allGroups]);
  const reviewableIds = reviewable.map((g) => g.id).join();

  const group =
    mode.mode === 'groups' && mode.group
      ? store.models.groupsOf(pr).find((g) => g.id === mode.group)
      : null;
  const groupHunkIds = group ? new Set(group.hunks) : null;

  // Like the prototype: in grouped mode a group is always selected —
  // preferring a reviewable one so a lockfile group is never the default.
  useEffect(() => {
    const first = reviewable[0] ?? allGroups[0];
    // A resumed group id the PR no longer has counts as none.
    const known = !!mode.group && allGroups.some((g) => g.id === mode.group);
    if (mode.mode === 'groups' && !known && first) {
      setMode((m) => ({ ...m, group: first.id }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode.mode, mode.group, allGroupIds, reviewableIds]);

  // Marks the current group read and moves on to the next unread one —
  // shared by the `R` shortcut and the menu's "Mark Group as Read".
  const markReadAndAdvance = useCallback(() => {
    const g = allGroups.find((x) => x.id === mode.group);
    if (!g) return;
    markGroupRead(store, pr, g.hunks);
    const reads = new Set(store.models.hunkReads.byPr(pr).map((r) => r.hunk));
    const next = nextUnreadGroup(allGroups, mode.group, reads);
    if (next) setMode((m) => ({ ...m, mode: 'groups', group: next.id }));
  }, [allGroups, mode.group, store, pr]);

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

  // Review items of the native menu bar (see core/menu.ts).
  useEffect(() => {
    const on = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      if (id === 'view-grouped') setMode((m) => ({ ...m, mode: 'groups' }));
      else if (id === 'view-files') setMode((m) => ({ ...m, mode: 'files' }));
      else if (id === 'view-split') ui.toggleDiffView();
      else if (id === 'mark-group-read') {
        const g = allGroups.find((x) => x.id === mode.group);
        if (g) markGroupRead(store, pr, g.hunks);
      } else if (id === 'ask-agent') {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: '/' }));
      } else if (id === 'open-on-host') {
        const url = summary?.url;
        if (url) openExternal(url);
      }
    };
    window.addEventListener(REVIEW_EVENT, on);
    return () => window.removeEventListener(REVIEW_EVENT, on);
  });

  useViewKeys(
    ui,
    (e) => {
      const k = latinKey(e);
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
        ui.goBack();
        return;
      }
      if (k === 'r') {
        markReadAndAdvance();
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
      markReadAndAdvance,
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
  // A branch review (no PR on the host) takes no host actions either.
  const branchReview = !!summary && isBranchReview(summary);
  const local = summary?.pr.repo.host === 'local' || branchReview;
  const finished = summary?.state === 'merged' || summary?.state === 'closed';
  const mine =
    !!summary && store.ephemeral.viewer?.login === summary.author.login;
  const mergeBlock = !summary
    ? ''
    : local
      ? 'local branch'
      : summary.conflicts
        ? 'conflicts with base'
        : failing
          ? `${failing} ${failing === 1 ? 'check' : 'checks'} failing`
          : summary.approvals < (summary.required_approvals ?? 0)
            ? `approvals ${summary.approvals}/${summary.required_approvals}`
            : '';

  return (
    <div ref={rootRef} className="review flex min-w-0 flex-1 flex-col">
      <Toolbar
        aria-label="PR"
        className="flex w-full flex-wrap items-center gap-3 border-b border-separator py-2.5 pl-6 pr-4"
      >
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
        <div className="rv-title flex min-w-0 flex-1 items-center gap-3 overflow-hidden">
          {summary ? (
            <>
              <span className="shrink-0 text-sm text-muted">
                {branchReview ? summary.head_ref : `#${summary.pr.number}`}
              </span>
              <Typography.Heading
                level={6}
                className="min-w-[12ch] flex-1 truncate"
              >
                {reviewTitle(store, pr, summary.title)}
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
        {!local && mine && summary && !finished && (
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
        {/* A merged or closed PR takes no more reviews, reviewers or merges. */}
        {!finished && !branchReview && (
          <Btn
            tone="primary"
            className="shrink-0"
            onPress={() => ui.openModal('submit')}
          >
            {compact ? 'Submit' : 'Submit review'}
          </Btn>
        )}
        {!local && !finished && FEATURES.hostWrites && (
          <ReviewerPicker pr={pr} compact={compact} />
        )}
        {!local && !finished && (
          <Tooltip>
            <Btn
              tone={mergeBlock ? 'tertiary' : 'success'}
              icon={<CodeMerge />}
              className="merge-btn shrink-0"
              isIconOnly={compact}
              aria-label="Merge"
              isDisabled={!FEATURES.hostWrites}
              onPress={() => setMergeOpen(true)}
            >
              {!compact && 'Merge'}
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
        {branchReview && (
          <Btn
            tone="tertiary"
            icon={<Xmark />}
            className="close-review shrink-0"
            isIconOnly={compact}
            aria-label="Close review"
            onPress={() => void closeBranchReview(store, pr)}
          >
            {!compact && 'Close review'}
          </Btn>
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
              <Tabs.Tab id="overview" className="gap-1.5">
                <FileText className="size-4" />
                Overview
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
                  onOpenFile={onOpenFile}
                />
              )}
              {tab === 'overview' && summary ? (
                <Overview
                  id={pr}
                  summary={summary}
                  detail={detail}
                  title={reviewTitle(store, pr, summary.title)}
                  progress={progressOf(store, pr)}
                  branchReview={branchReview}
                />
              ) : tab === 'checks' ? (
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
          <K>P</K> group <K>R</K> mark read <K>V</K> viewed <K>C</K> comment{' '}
          <K>E</K> context <K>S</K> split <K>/</K> ask AI <K>]</K> AI panel{' '}
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
