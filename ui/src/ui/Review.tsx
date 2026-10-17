import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  Comments as CommentsIcon,
  LayoutSideContentRight,
} from '@gravity-ui/icons';
import {
  Breadcrumbs,
  Button,
  Chip,
  Spinner,
  ToggleButton,
  Toolbar,
  Tooltip,
  Typography,
} from '@heroui/react';
import { observer } from 'mobx-react-lite';
import type { PrId } from '../gen/contract';
import { api } from '../core/api';
import { useRootStore, useUi } from '../stores/context';
import { Btn, K } from './bits';
import { DiffPane } from './DiffPane';
import { GroupsPane, type ReviewMode } from './GroupsPane';
import { SidePanel } from './SidePanel';
import { PRIcon, prStatusLabel } from './StatusIcon';

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

  useEffect(() => {
    void store.sync.openPr(pr);
  }, [store, pr]);

  const summary = store.models.prSummaries.get(pr);
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

      {unresolved > 0 && (
        <div className="flex items-center gap-2 border-b border-separator px-4 py-1.5 text-xs text-warning">
          <CommentsIcon className="size-3.5" />
          {unresolved} unresolved thread{unresolved === 1 ? '' : 's'}
        </div>
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
          <DiffPane pr={pr} rev={revision.data!} mode={mode} />
          {ui.aside && <SidePanel pr={pr} />}
        </div>
      )}
    </div>
  );
});
