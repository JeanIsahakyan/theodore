import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  Comments as CommentsIcon,
  LayoutSideContentRight,
} from '@gravity-ui/icons';
import { CircleCheck, Code, CodeCommit } from '@gravity-ui/icons';
import {
  Breadcrumbs,
  Button,
  Chip,
  Disclosure,
  Separator,
  Spinner,
  Tabs,
  ToggleButton,
  Toolbar,
  Tooltip,
  Typography,
} from '@heroui/react';
import { observer } from 'mobx-react-lite';
import type { PrId } from '../gen/contract';
import { api } from '../core/api';
import { Md } from '../highlight';
import { useRootStore, useUi } from '../stores/context';
import { Btn, CheckIcon, K } from './bits';
import { Checks, Commits, ReviewerStrip } from './Checks';
import { DiffPane } from './DiffPane';
import { GroupsPane, type ReviewMode } from './GroupsPane';
import { SidePanel } from './SidePanel';
import { PRIcon, prStatusLabel } from './StatusIcon';

type PrTab = 'diff' | 'checks' | 'commits';

function progressOf(store: ReturnType<typeof useRootStore>, pr: PrId): number {
  const reads = store.models.hunkReads.where((r) => r.pr === pr);
  const groups = store.models.groups.all().filter((g) => g.kind !== 'hidden');
  const hunks = groups.flatMap((g) => g.hunks);
  if (!hunks.length) return 0;
  const readSet = new Set(reads.map((r) => r.hunk));
  return hunks.filter((h) => readSet.has(h)).length / hunks.length;
}

export const Review = observer(function Review({ pr }: { pr: PrId }) {
  const store = useRootStore();
  const ui = useUi();
  const [mode, setMode] = useState<ReviewMode>({
    mode: 'files',
    group: null,
    file: null,
  });
  const [tab, setTab] = useState<PrTab>('diff');

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

  useEffect(() => {
    if (!mode.file && revision?.data?.files.length) {
      setMode((m) => ({ ...m, file: m.file ?? revision.data!.files[0]!.path }));
    }
  }, [revision?.data, mode.file]);

  const unresolved = store.models.threads.where((t) => !t.resolved).length;

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
            </>
          ) : (
            <Spinner size="sm" />
          )}
        </div>
        <Btn tone="primary" onPress={() => ui.openModal('submit')}>
          Submit review
        </Btn>
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
        <span className="flex-1" />
        {detail && detail.reviewers.length > 0 && (
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
              {summary.approvals}/{summary.required_approvals ?? '–'}
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

      {detail?.body && (
        <Disclosure className="description border-b border-separator px-4">
          <Disclosure.Heading>
            <Disclosure.Trigger className="flex items-center gap-1.5 py-2 text-sm text-muted">
              Description
              <Disclosure.Indicator />
            </Disclosure.Trigger>
          </Disclosure.Heading>
          <Disclosure.Content>
            <Disclosure.Body className="max-w-[78ch] pb-3">
              <Md text={detail.body} />
            </Disclosure.Body>
          </Disclosure.Content>
        </Disclosure>
      )}

      {!revision || revision.status === 'loading' ? (
        <div className="flex flex-1 items-center justify-center text-muted">
          <Spinner />
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
          />
          {tab === 'checks' ? (
            <Checks pr={pr} checks={checks} />
          ) : tab === 'commits' ? (
            <Commits commits={detail?.commits ?? []} />
          ) : (
            <DiffPane pr={pr} rev={revision.data!} mode={mode} />
          )}
          {ui.aside && <SidePanel pr={pr} />}
        </div>
      )}
    </div>
  );
});
