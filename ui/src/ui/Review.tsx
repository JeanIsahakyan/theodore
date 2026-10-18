import { REVIEW_EVENT } from '../core/menu';
import { DiffSkeleton } from './Loading';
import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  ClockArrowRotateLeft,
  CodeMerge,
  Comments as CommentsIcon,
  LayoutRows,
  LayoutSideContentRight,
  LayoutSplitColumns,
  Play,
  Stop,
} from '@gravity-ui/icons';
import { CircleCheck, Code, CodeCommit } from '@gravity-ui/icons';
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
import type { PrId } from '../gen/contract';
import { api } from '../core/api';
import { markGroupRead } from '../actions';
import { FEATURES } from '../features';
import { Md } from '../highlight';
import { useRootStore, useUi } from '../stores/context';
import { Btn, CheckIcon, K } from './bits';
import { Checks, Commits, ReviewerStrip } from './Checks';
import { DiffPane } from './DiffPane';
import { sinceHunks, type SinceKind } from './diff';
import { GroupsPane, groupsForRevision, type ReviewMode } from './GroupsPane';
import { MergeDialog } from './Merge';
import { SidePanel } from './SidePanel';
import { PRIcon, prStatusLabel } from './StatusIcon';
import { useViewKeys } from './keys';

/** Live updates: green while synced, amber on cached/rate-limited reads, red
 *  offline. Ported from the prototype's `LiveDot`, minus the fake `feed`
 *  popover (nothing backs it) — driven by the real `hostStatus` instead of
 *  demo fault injection. */
const LiveDot = observer(function LiveDot() {
  const store = useRootStore();
  const s = store.ephemeral.hostStatus;
  const rateLimited = !!s.rateLimitedUntil && s.rateLimitedUntil > Date.now();
  const [color, text] = !s.online
    ? ['bg-danger', 'offline — showing cache']
    : rateLimited || !s.authOk
      ? ['bg-warning', 'updates paused']
      : ['bg-success', 'live'];
  return (
    <Tooltip>
      <Chip
        size="sm"
        variant="secondary"
        className="live-dot shrink-0 gap-1.5 px-1.5"
      >
        <span className="relative flex size-2">
          {color === 'bg-success' && (
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-50 motion-reduce:hidden" />
          )}
          <span
            className={`relative inline-flex size-2 rounded-full ${color}`}
          />
        </span>
      </Chip>
      <Tooltip.Content>Updates: {text}</Tooltip.Content>
    </Tooltip>
  );
});

type LinearRef = { key: string; state: string; title: string };

// `PrSummary` has no Linear field at all yet (`FEATURES.linear`). Behind a
// function call so TS can't fold it to the literal `null` and narrow every
// read of it to `never` — a plain `const x: T | null = null` would.
function linearOf(): LinearRef | null {
  return null;
}

type PrTab = 'diff' | 'checks' | 'commits';

const lastSeenKey = (pr: PrId) => `theodore-lastseen:${pr}`;

function progressOf(store: ReturnType<typeof useRootStore>, pr: PrId): number {
  const reads = store.models.hunkReads.where((r) => r.pr === pr);
  const groups = store.models.groupsOf(pr).filter((g) => g.kind !== 'hidden');
  const hunks = groups.flatMap((g) => g.hunks);
  if (!hunks.length) return 0;
  const readSet = new Set(reads.map((r) => r.hunk));
  return hunks.filter((h) => readSet.has(h)).length / hunks.length;
}

export const Review = observer(function Review({ pr }: { pr: PrId }) {
  const store = useRootStore();
  const ui = useUi();
  // Grouped by default — the point of the product; Files is the fallback view.
  const [mode, setMode] = useState<ReviewMode>({
    mode: 'groups',
    group: null,
    file: null,
  });
  const [tab, setTab] = useState<PrTab>('diff');
  const [tour, setTour] = useState<number | null>(null);
  const [sinceOnly, setSinceOnly] = useState(false);
  const [baselineSha, setBaselineSha] = useState<string | null>(null);
  const [mergeOpen, setMergeOpen] = useState(false);
  // `PrSummary` has no Linear field at all yet (`FEATURES.linear`); kept as a
  // typed placeholder so the chip's shape stays, pointed at nothing, rather
  // than being deleted — wiring up the real field later is then a one-line
  // change instead of new JSX.
  const linear = linearOf();
  // Widened to `boolean` on purpose: `FEATURES.linear` is the literal `false`,
  // and TS narrows an always-false `&&` chain's later operands to `never` —
  // widening keeps `linear.key` below type-checking as real, reachable code.
  const linearEnabled: boolean = FEATURES.linear;

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
  const since: Map<string, SinceKind> | null =
    baselineRevision?.status === 'ready' && revision?.data
      ? sinceHunks(baselineRevision.data!.files, revision.data.files)
      : null;
  const sinceCount = since?.size ?? 0;

  useEffect(() => {
    if (!mode.file && revision?.data?.files.length) {
      setMode((m) => ({ ...m, file: m.file ?? revision.data!.files[0]!.path }));
    }
  }, [revision?.data, mode.file]);

  const orderedGroups = revision?.data
    ? groupsForRevision(store, pr, revision.data)
    : [];
  const orderedGroupIds = orderedGroups.map((g) => g.id).join();

  // Like the prototype: in grouped mode a group is always selected.
  useEffect(() => {
    const first = orderedGroups[0];
    if (mode.mode === 'groups' && !mode.group && first) {
      setMode((m) => ({ ...m, group: first.id }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode.mode, mode.group, orderedGroupIds]);

  // Tour drives group selection; keep `mode` in sync with the tour cursor.
  useEffect(() => {
    if (tour == null) return;
    const g = orderedGroups[tour];
    if (g) setMode((m) => ({ ...m, mode: 'groups', group: g.id }));
    else setTour(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tour, orderedGroupIds]);

  const startTour = () => {
    const reads = new Set(
      store.models.hunkReads.where((r) => r.pr === pr).map((r) => r.hunk),
    );
    const firstUnread = orderedGroups.findIndex(
      (g) => !g.hunks.every((h) => reads.has(h)),
    );
    setTour(firstUnread >= 0 ? firstUnread : 0);
  };

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
        const g = orderedGroups.find((x) => x.id === mode.group);
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
      if (e.key === 't' || e.key === 'T') {
        if (tour === null) startTour();
        else setTour(null);
        return;
      }
      if (e.key === 's' || e.key === 'S') {
        ui.toggleDiffView();
        return;
      }
      if (e.key === '/') {
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
      if (e.key !== 'r' && e.key !== 'R') return false;
      if (tour == null) return false;
      const g = orderedGroups[tour];
      if (g) markGroupRead(store, pr, g.hunks);
      setTour(tour + 1 < orderedGroups.length ? tour + 1 : null);
    },
    [tour, orderedGroupIds, pr],
  );

  const unresolved = (detail?.threads ?? []).filter((t) => !t.resolved).length;
  const local = summary?.pr.repo.host === 'local';
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
    <div className="review flex min-w-0 flex-1 flex-col">
      <Toolbar
        aria-label="PR"
        className="flex w-full items-center gap-3 border-b border-separator px-4 py-2.5"
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
        <div className="rv-title flex min-w-0 flex-1 items-center gap-3">
          {summary ? (
            <>
              <Breadcrumbs className="shrink-0 text-sm">
                <Breadcrumbs.Item onPress={() => ui.goBack()}>
                  {summary.pr.repo.owner}/{summary.pr.repo.name}
                </Breadcrumbs.Item>
                <Breadcrumbs.Item>#{summary.pr.number}</Breadcrumbs.Item>
              </Breadcrumbs>
              <Typography.Heading level={6} className="truncate">
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
              {linearEnabled && linear && (
                <Tooltip>
                  <Chip
                    size="sm"
                    variant="secondary"
                    className="lin shrink-0 whitespace-nowrap tabular-nums"
                  >
                    {linear.key} · {linear.state}
                  </Chip>
                  <Tooltip.Content>{linear.title}</Tooltip.Content>
                </Tooltip>
              )}
              {summary.pr.repo.host !== 'local' && <LiveDot />}
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
        <Btn tone="primary" onPress={() => ui.openModal('submit')}>
          Submit review
        </Btn>
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
            isSelected={ui.aside}
            onChange={(v) => ui.toggleAside(v)}
            aria-label="AI panel"
          >
            <LayoutSideContentRight className="size-4" />
          </ToggleButton>
          <Tooltip.Content>
            {ui.aside ? 'Hide' : 'Show'} AI, tasks and threads <K>]</K>
          </Tooltip.Content>
        </Tooltip>
      </Toolbar>

      <Toolbar
        aria-label="Sections and people"
        className="flex w-full items-center gap-4 border-b border-separator px-4 py-2"
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
        <div
          className={`grid min-h-0 flex-1 ${ui.aside ? 'grid-cols-[256px_minmax(0,1fr)_352px]' : 'grid-cols-[256px_minmax(0,1fr)]'}`}
        >
          <GroupsPane
            pr={pr}
            rev={revision.data!}
            mode={mode}
            setMode={setMode}
            since={since}
            sinceOnly={sinceOnly && sinceCount > 0}
            onTourFrom={(groupId) => {
              const idx = orderedGroups.findIndex((g) => g.id === groupId);
              if (idx >= 0) setTour(idx);
            }}
          />
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
              tour={tour !== null}
            />
          )}
          {ui.aside && <SidePanel pr={pr} />}
        </div>
      )}
      {mergeOpen && <MergeDialog pr={pr} onClose={() => setMergeOpen(false)} />}
    </div>
  );
});
