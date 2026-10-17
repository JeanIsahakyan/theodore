import { Check, TriangleExclamation } from '@gravity-ui/icons';
import { ListBox, ProgressBar, Surface, Tabs, Tooltip } from '@heroui/react';
import { observer } from 'mobx-react-lite';
import type { FileDiff, HunkId, PrId, Revision } from '../gen/contract';
import { useRootStore } from '../stores/context';

export interface ReviewMode {
  mode: 'groups' | 'files';
  group: string | null;
  file: string | null;
}

const short = (p: string) => p.split('/').slice(-2).join('/');

/** Groups loaded for this PR whose hunks are part of the open revision —
 *  see the final report on why `Group` needs its own `pr` field. */
function groupsForRevision(
  store: ReturnType<typeof useRootStore>,
  rev: Revision,
) {
  const hunkIds = new Set(rev.files.flatMap((f) => f.hunks.map((h) => h.id)));
  return store.models.groups
    .all()
    .filter((g) => g.hunks.some((h) => hunkIds.has(h)))
    .filter((g) => g.kind !== 'hidden');
}

export const GroupsPane = observer(function GroupsPane({
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
  const groups = groupsForRevision(store, rev);
  const hunkReads = store.models.hunkReads.where((r) => r.pr === pr);
  const readSet = new Set(hunkReads.map((r) => r.hunk));
  const fileViews = store.models.fileViews.where((v) => v.pr === pr);
  const viewedCount = fileViews.filter((v) => v.state === 'viewed').length;

  const selectFile = (path: string) =>
    setMode({ mode: 'files', group: mode.group, file: path });

  return (
    <Surface
      variant="secondary"
      className="groups flex min-h-0 flex-col border-r border-separator"
    >
      <Tabs
        selectedKey={mode.mode}
        onSelectionChange={(k) =>
          setMode({
            mode: k as ReviewMode['mode'],
            group: mode.group,
            file: mode.file ?? rev.files[0]?.path ?? null,
          })
        }
        className="mode-tabs mx-4 mb-2 mt-4"
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

      <div className="min-h-0 flex-1 overflow-auto px-2 pb-4">
        {mode.mode === 'groups' ? (
          <ListBox
            aria-label="Groups"
            selectionMode="single"
            selectedKeys={mode.group ? [mode.group] : []}
            onSelectionChange={(keys) => {
              const k = keys === 'all' ? undefined : [...keys][0];
              if (k)
                setMode({ mode: 'groups', group: String(k), file: mode.file });
            }}
            className="p-0"
          >
            {groups.map((g) => {
              const hs = g.hunks;
              const read = hs.filter((h) => readSet.has(h)).length;
              return (
                <ListBox.Item
                  key={g.id}
                  id={g.id}
                  textValue={g.title}
                  className="grp flex-col items-start gap-1 rounded-2xl px-3 py-2"
                >
                  <span className="flex w-full items-start gap-1.5">
                    <span className="flex-1 text-sm font-medium">
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
                    {read === hs.length && (
                      <Check className="size-4 text-success" />
                    )}
                  </span>
                  <span className="text-xs text-muted">
                    {hs.length} hunk{hs.length === 1 ? '' : 's'} · {read}/
                    {hs.length} read
                  </span>
                </ListBox.Item>
              );
            })}
          </ListBox>
        ) : (
          <ListBox
            aria-label="Files"
            selectionMode="single"
            selectedKeys={mode.file ? [mode.file] : []}
            onSelectionChange={(keys) => {
              const k = keys === 'all' ? undefined : [...keys][0];
              if (k !== undefined) selectFile(String(k));
            }}
            className="p-0"
          >
            {rev.files.map((f: FileDiff) => {
              const views = fileViews.find((v) => v.path === f.path);
              return (
                <ListBox.Item
                  key={f.path}
                  id={f.path}
                  textValue={f.path}
                  className="min-h-6 gap-1.5 px-1.5 py-1 text-xs"
                >
                  <span
                    className={`w-3 text-center font-mono font-semibold ${views?.state === 'viewed' ? 'text-success' : ''}`}
                  >
                    {f.status === 'added'
                      ? 'A'
                      : f.status === 'deleted'
                        ? 'D'
                        : f.status === 'renamed'
                          ? 'R'
                          : 'M'}
                  </span>
                  <span
                    className="min-w-0 flex-1 truncate font-mono"
                    title={f.path}
                  >
                    {short(f.path)}
                  </span>
                </ListBox.Item>
              );
            })}
          </ListBox>
        )}
      </div>

      <div className="groups-foot flex flex-col gap-2 border-t border-separator px-4 py-3 text-xs">
        <ProgressBar
          aria-label="Viewed"
          value={viewedCount}
          maxValue={rev.files.length}
          size="sm"
          color="success"
        >
          <ProgressBar.Track>
            <ProgressBar.Fill />
          </ProgressBar.Track>
        </ProgressBar>
        <span className="text-muted">
          Viewed: {viewedCount}/{rev.files.length} files
        </span>
      </div>
    </Surface>
  );
});

export const groupHunkIds = (
  store: ReturnType<typeof useRootStore>,
  groupId: string,
): HunkId[] => store.models.groups.get(groupId)?.hunks ?? [];
