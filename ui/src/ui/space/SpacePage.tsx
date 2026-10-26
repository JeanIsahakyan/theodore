/**
 * Spaces (docs/spaces.md), hidden behind build mode: the space page (chat
 * with the agent on the left, the live diff vs base on the right), the
 * New space dialog, Settings → Labs, and the "turn done" notices.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';

import {
  Archive,
  ArrowUpFromLine,
  ArrowUturnCcwLeft,
  BranchesRight,
  ChevronDown,
  ChevronRight,
  CodeMerge,
  CodePullRequest,
  Folder,
  LayoutSideContentRight,
} from '@gravity-ui/icons';
import {
  Alert,
  Button,
  Card,
  Dropdown,
  Input,
  InputGroup,
  Label,
  Modal,
  Popover,
  Switch,
  TextField,
  ToggleButton,
  Tooltip,
  Typography,
} from '@heroui/react';
import { observer } from 'mobx-react-lite';
import type {
  HunkId,
  ShipAction,
  Space,
  SpaceConfigView,
  SpaceMode,
} from '../../gen/contract';
import { api } from '../../core/api';
import { STORAGE_NS } from '../../stores/UiStore';
import { ALL } from '../../core/workspaces';
import { FEATURES } from '../../features';
import { setSetting } from '../../actions';

import { useRootStore, useUi } from '../../stores/context';
import { Hints, K, Spinner } from '../bits';
import { DiffPane, type ComposerState } from '../DiffPane';
import type { ReviewMode } from '../GroupsPane';
import { ToolCalls } from '../SidePanel';
import { rich } from '../../highlight';
import { latinKey, useViewKeys } from '../keys';
import {
  AgentChip,
  ChipMenu,
  Composer,
  parseAgentChoice,
  type AgentChoice,
} from './Composer';
import { isBuildMode } from './mode';
import { markSpaceSeen } from './seen';
import {
  checksByReply,
  runControl,
  runsByReply,
  settingUp,
  setupView,
} from './commands';
import { GlobalConfigSection } from './ConfigSection';
import {
  CheckChip,
  LogsDrawer,
  LogsToggle,
  PortChips,
  RunButton,
  SetupNote,
  SetupStage,
  TrustPrompt,
  toggleRun,
  useSpaceConfig,
  useSpaceLogsSeed,
} from './SpaceCommands';
import {
  AUTO_ARCHIVE_KEY,
  BUILD_MODE_KEY,
  NOTIFY_KEY,
  STAGE_LABEL,
  autoArchiveDays,
  defaultTitle,
  diffStat,
  nextMode,
  notifyOn,
  spaceKeyAction,
  spaceChatKey,
  spaceStage,
  undoState,
  undoneMessages,
  unshipped,
  spaceTitle,
} from './spaces';

/** What the agent may do in a turn (docs/spaces.md §5). */
const MODES: { id: SpaceMode; label: string; hint: string }[] = [
  { id: 'ask', label: 'Ask', hint: 'Read only, no edits' },
  { id: 'edit', label: 'Edit', hint: 'Edit files in the space' },
  { id: 'run', label: 'Run', hint: 'Edit and run any command' },
];

/** The whole branch diff, ungrouped — every file of the revision. */
const WHOLE_DIFF: ReviewMode = { mode: 'groups', group: null, file: null };

type Store = ReturnType<typeof useRootStore>;

const LS_SPACE_CHANGES = `${STORAGE_NS}theodore-space-changes`;
type Ui = ReturnType<typeof useUi>;

/** What the page's keys reach inside the chat and the ship controls. */
interface ChatHandle {
  focus: () => void;
  cycleMode: () => void;
}
interface ShipHandle {
  primary: () => void;
  alternate: () => void;
}

async function openGroupedReview(store: Store, ui: Ui, space: Space) {
  const res = await api.spaceReview({ space: space.id, group: true });
  await store.sync.openPr(res.pr);
  ui.go({ name: 'review', pr: res.pr });
}

function openSpacePr(store: Store, ui: Ui, space: Space) {
  const id = space.pr;
  if (!id) return;
  void store.sync.openPr(id).then(() => ui.go({ name: 'review', pr: id }));
}

function archive(ui: Ui, space: Space) {
  void api
    .archiveSpace(space.id)
    .then(() => ui.goBack())
    .catch(() => {});
}

/** Undo last turn (button on the reply, palette). Errors are toasted by
 *  api.ts. */
export function undoLastTurn(space: Pick<Space, 'id'>): Promise<void> {
  return api
    .undoSpaceTurn(space.id)
    .then(() => {})
    .catch(() => {});
}

export function unarchive(space: Pick<Space, 'id'>): Promise<void> {
  return api
    .unarchiveSpace(space.id)
    .then(() => {})
    .catch(() => {});
}

export const SpacePage = observer(function SpacePage({ id }: { id: string }) {
  const store = useRootStore();
  const ui = useUi();
  const space = store.models.spaces.get(id);
  const chat = useRef<ChatHandle | null>(null);
  const ship = useRef<ShipHandle | null>(null);
  const { config, refresh: refreshConfig } = useSpaceConfig(id, space);
  const [logsOpen, setLogsOpen] = useState(false);
  // The changes pane can be hidden for a chat-only page; remembered for
  // every space (it's a way of working, not a per-space thing).
  const [showChanges, setShowChanges] = useState(
    () => localStorage.getItem(LS_SPACE_CHANGES) !== '0',
  );
  const toggleChanges = () =>
    setShowChanges((v) => {
      localStorage.setItem(LS_SPACE_CHANGES, v ? '0' : '1');
      return !v;
    });
  useSpaceLogsSeed(id);
  const run = space ? runControl(config, space) : null;

  // Page keys (docs/spaces.md §3) — never while typing in the composer.
  useViewKeys(
    ui,
    (e) => {
      if (!space || e.key === 'Escape') return false;
      const action = spaceKeyAction(latinKey(e), e.shiftKey);
      const archived = space.status === 'archived';
      const running = space.status === 'running';
      switch (action) {
        case 'focus':
          chat.current?.focus();
          return;
        case 'mode':
          chat.current?.cycleMode();
          return;
        case 'review':
          if (!archived)
            void openGroupedReview(store, ui, space).catch(() => {});
          return;
        case 'run':
          if (!run) return false;
          void toggleRun(space, !run.running);
          return;
        case 'ship':
          ship.current?.primary();
          return;
        case 'ship-alt':
          ship.current?.alternate();
          return;
        case 'open-pr':
          if (space.pr) openSpacePr(store, ui, space);
          return;
        case 'changes':
          toggleChanges();
          return;
        case 'archive':
          if (!running && !archived) archive(ui, space);
          return;
        default:
          return false;
      }
    },
    [space?.id, space?.status, space?.pr, run?.running, !!run],
  );

  // ⌘. stops the turn — from anywhere on the page, the composer included.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || latinKey(e) !== '.') return;
      if (store.models.spaces.get(id)?.status !== 'running') return;
      e.preventDefault();
      void api.spaceStop(id).catch(() => {});
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [store, id]);

  useEffect(() => {
    void store.sync.openPr(spaceChatKey(id));
  }, [store, id]);

  // Open the live diff without grouping before anything asks for its
  // revision (a cold `get_revision` would open it grouped).
  const [opened, setOpened] = useState(false);
  const live = space && space.status !== 'archived';
  useEffect(() => {
    if (!live) return;
    let on = true;
    api
      .spaceReview({ space: id, group: false })
      .then(() => on && setOpened(true))
      .catch(() => {});
    return () => {
      on = false;
    };
  }, [id, live]);

  // Seen only when you can see it: a turn that ends with the window in the
  // background still counts on the dock badge until you come back.
  const updatedAt = space?.updated_at;
  useEffect(() => {
    if (updatedAt == null) return;
    const mark = () => markSpaceSeen(id, updatedAt);
    if (document.hasFocus()) mark();
    window.addEventListener('focus', mark);
    return () => window.removeEventListener('focus', mark);
  }, [id, updatedAt]);

  if (!space) {
    return (
      <div className="view grid flex-1 place-items-center text-muted">
        This space no longer exists.
      </div>
    );
  }
  return (
    <div className="view space-page flex min-w-0 flex-1 flex-col">
      <SpaceHeader
        space={space}
        ship={ship}
        config={config}
        logsOpen={logsOpen}
        onToggleLogs={() => setLogsOpen((v) => !v)}
        showChanges={showChanges}
        onToggleChanges={toggleChanges}
      />
      <div className="flex min-h-0 flex-1">
        <section
          className={
            showChanges
              ? 'flex w-[40%] min-w-[340px] flex-col border-r border-separator bg-background'
              : 'flex w-full min-w-0 flex-col bg-background'
          }
        >
          <div className="mx-auto w-full max-w-[860px]">
            <TrustPrompt
              space={space}
              config={config}
              onChanged={refreshConfig}
            />
          </div>
          <SpaceChat space={space} handle={chat} />
        </section>
        {showChanges && (
          <section className="flex min-w-0 flex-1 flex-col">
            {opened || !live ? (
              <SpaceChanges space={space} />
            ) : (
              <div className="grid flex-1 place-items-center text-muted">
                <Spinner />
              </div>
            )}
          </section>
        )}
      </div>
      {logsOpen && (
        <LogsDrawer space={space} onClose={() => setLogsOpen(false)} />
      )}
      {space.status === 'archived' && <ArchivedBanner space={space} />}
      <Hints>
        <K>C</K> message the agent <K>M</K> mode <K>D</K> changes <K>⌘.</K> stop{' '}
        <K>R</K> review <K>P</K> {space.pr ? 'push' : 'ship'}
        {space.pr ? (
          <>
            {' '}
            <K>O</K> open PR
          </>
        ) : null}
        {run ? (
          <>
            {' '}
            <K>⇧R</K> {run.running ? 'stop' : 'run'}
          </>
        ) : null}{' '}
        <K>⇧E</K> archive <K>Esc</K> back
      </Hints>
    </div>
  );
});

function ArchivedBanner({ space }: { space: Space }) {
  const [busy, setBusy] = useState(false);
  return (
    <Alert status="accent" className="m-3 items-center">
      <Alert.Content>
        <Alert.Description>
          Archived. The transcript and the checkpoint ref are kept.
        </Alert.Description>
      </Alert.Content>
      <Button
        size="sm"
        variant="secondary"
        className="space-unarchive shrink-0"
        isPending={busy}
        onPress={() => {
          setBusy(true);
          void unarchive(space).finally(() => setBusy(false));
        }}
      >
        <ArrowUturnCcwLeft className="size-3.5" />
        Unarchive
      </Button>
    </Alert>
  );
}

const SpaceHeader = observer(function SpaceHeader({
  space,
  ship,
  config,
  logsOpen,
  onToggleLogs,
  showChanges,
  onToggleChanges,
}: {
  space: Space;
  ship: MutableRefObject<ShipHandle | null>;
  config: SpaceConfigView | null;
  logsOpen: boolean;
  onToggleLogs: () => void;
  showChanges: boolean;
  onToggleChanges: () => void;
}) {
  const store = useRootStore();
  const ui = useUi();
  const [busy, setBusy] = useState(false);
  const running = space.status === 'running';
  const archived = space.status === 'archived';
  const project = store.models.projects.get(space.project);
  const pr = space.pr ? store.models.prSummaries.get(space.pr) : undefined;
  const stage = spaceStage(space, pr?.state);
  const days = autoArchiveDays(store.models.settings.all());
  return (
    // Just what you act on: the name, and the stage only once it says
    // something (in review, done). Branch, base and agent are in the
    // name's tooltip.
    <header className="flex min-h-14 flex-nowrap items-center gap-2 border-b border-separator px-6 py-2 [&>button]:shrink-0">
      <Typography.Heading
        level={6}
        className="min-w-0 shrink truncate"
        title={`${space.branch} ← ${space.base} · ${space.agent}`}
      >
        {spaceTitle(space)}
      </Typography.Heading>
      {stage !== 'drafting' && (
        <span
          className="space-stage shrink-0 rounded-full bg-default px-2 py-0.5 text-xs"
          title={
            space.done_at && days > 0
              ? `Archives itself ${days} day${days === 1 ? '' : 's'} after it was done`
              : undefined
          }
        >
          {STAGE_LABEL[stage]}
          {pr ? ` · #${pr.pr.number}` : ''}
        </span>
      )}
      <span className="flex-1" />
      <RunButton space={space} config={config} />
      <PortChips space={space} />
      <LogsToggle open={logsOpen} onToggle={onToggleLogs} />
      <Button
        size="sm"
        variant="secondary"
        isDisabled={busy || archived}
        onPress={async () => {
          setBusy(true);
          try {
            await openGroupedReview(store, ui, space);
          } catch {
            // toasted by api.ts
          } finally {
            setBusy(false);
          }
        }}
      >
        Review
      </Button>
      {!archived && project && (
        <ShipControls
          space={space}
          local={project.path != null}
          handle={ship}
        />
      )}
      {space.pr && (
        <Button
          size="sm"
          variant="ghost"
          onPress={() => openSpacePr(store, ui, space)}
        >
          <CodePullRequest className="size-3.5" />
          PR
        </Button>
      )}
      <Tooltip>
        <Button
          size="sm"
          variant="ghost"
          aria-label="Archive space"
          isIconOnly
          className="space-archive shrink-0"
          isDisabled={running || archived}
          onPress={() => archive(ui, space)}
        >
          <Archive className="size-4" />
        </Button>
        <Tooltip.Content>
          Archive <K>⇧E</K> — removes the worktree; the transcript and
          checkpoints are kept
        </Tooltip.Content>
      </Tooltip>
      <Tooltip>
        <ToggleButton
          isIconOnly
          size="sm"
          aria-label="Changes"
          className="shrink-0"
          isSelected={showChanges}
          onChange={onToggleChanges}
        >
          <LayoutSideContentRight className="size-4" />
        </ToggleButton>
        <Tooltip.Content>
          {showChanges ? 'Hide' : 'Show'} the changes <K>D</K>
        </Tooltip.Content>
      </Tooltip>
    </header>
  );
});

interface ShipChoice {
  action: ShipAction;
  label: string;
  /** One line under the title field: what happens on confirm. */
  hint: string;
}

/** Open PR (▾ Open as draft) / Push on a host project; Merge locally
 *  (▾ Keep as branch) on a local folder. Confirming lets you edit the
 *  commit / PR title first. */
const ShipControls = observer(function ShipControls({
  space,
  local,
  handle,
}: {
  space: Space;
  local: boolean;
  /** `P` / `⇧P` on the page. */
  handle: MutableRefObject<ShipHandle | null>;
}) {
  const store = useRootStore();
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<ShipChoice | null>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const running = space.status === 'running';
  const changed = space.head_sha !== space.base_sha;

  const ship = async (action: ShipAction, t: string | null) => {
    setBusy(true);
    try {
      const s = await api.shipSpace({ space: space.id, action, title: t });
      setOpen(false);
      const where = s.shipped?.branch ?? s.branch;
      store.ephemeral.toast(
        action === 'merge_locally'
          ? `Merged into ${where}`
          : action === 'keep_branch'
            ? `Wrote branch ${where}`
            : action === 'push'
              ? `Pushed to ${where}`
              : `Pushed ${where}; opening the PR…`,
        'info',
      );
    } catch {
      // toasted by api.ts; the popover stays open to retry
    } finally {
      setBusy(false);
    }
  };

  if (space.pr) {
    const pending = unshipped(space);
    handle.current = {
      primary: () => {
        if (!running && !busy && pending) void ship('push', null);
      },
      alternate: () => {},
    };
    return (
      <Tooltip>
        <Button
          size="sm"
          variant="secondary"
          className="space-push"
          isDisabled={running || busy || !pending}
          isPending={busy}
          onPress={() => void ship('push', null)}
        >
          <ArrowUpFromLine className="size-3.5" />
          Push
        </Button>
        <Tooltip.Content>
          {pending
            ? 'One new commit on the PR branch with the turns since the last push'
            : 'Nothing new since the last push'}
        </Tooltip.Content>
      </Tooltip>
    );
  }

  const primary: ShipChoice = local
    ? {
        action: 'merge_locally',
        label: 'Merge locally',
        hint: "One commit by you, merged into the folder's checked-out branch. Refused if the folder has uncommitted changes or the merge conflicts.",
      }
    : {
        action: 'open_pr',
        label: 'Open PR',
        hint: `One commit by you, pushed to ${space.branch}, opened as a PR into ${space.base}.`,
      };
  const alternate: ShipChoice = local
    ? {
        action: 'keep_branch',
        label: 'Keep as branch',
        hint: `One commit by you, written as branch ${space.branch} in the folder. Nothing is checked out or merged.`,
      }
    : {
        action: 'open_draft_pr',
        label: 'Open as draft',
        hint: `One commit by you, pushed to ${space.branch}, opened as a draft PR into ${space.base}.`,
      };
  const shippedLocally =
    space.shipped != null && space.shipped.how !== 'pr' && !unshipped(space);
  const disabled = running || busy || !changed || shippedLocally;
  const start = (c: ShipChoice) => {
    setChoice(c);
    setTitle(defaultTitle(space));
    setOpen(true);
  };
  const current = choice ?? primary;
  handle.current = {
    primary: () => !disabled && start(primary),
    alternate: () => !disabled && start(alternate),
  };

  return (
    <div className="space-ship flex items-center">
      <Popover isOpen={open} onOpenChange={setOpen}>
        <Button
          size="sm"
          variant="primary"
          className="rounded-r-none"
          isDisabled={disabled}
          onPress={() => start(primary)}
        >
          {local ? (
            <CodeMerge className="size-3.5" />
          ) : (
            <CodePullRequest className="size-3.5" />
          )}
          {space.shipped?.how === 'pr' ? 'Open PR again' : primary.label}
        </Button>
        <Popover.Content
          placement="bottom end"
          offset={8}
          className="w-[380px]"
        >
          <Popover.Dialog className="flex flex-col gap-3 p-4">
            <Popover.Heading className="text-sm font-semibold">
              {current.label}
            </Popover.Heading>
            <TextField value={title} onChange={setTitle} autoFocus>
              <Label>Title</Label>
              <Input
                className="text-sm"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && title.trim()) {
                    void ship(current.action, title.trim());
                  }
                }}
              />
            </TextField>
            <span className="text-xs text-muted">{current.hint}</span>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onPress={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                isPending={busy}
                isDisabled={!title.trim()}
                onPress={() => void ship(current.action, title.trim())}
              >
                {current.label}
              </Button>
            </div>
          </Popover.Dialog>
        </Popover.Content>
      </Popover>
      <Dropdown>
        <Button
          size="sm"
          variant="primary"
          isIconOnly
          className="rounded-l-none border-l border-separator"
          aria-label="More ways to ship"
          isDisabled={disabled}
        >
          <ChevronDown className="size-3.5" />
        </Button>
        <Dropdown.Popover placement="bottom end">
          <Dropdown.Menu aria-label="Ship" onAction={() => start(alternate)}>
            <Dropdown.Item id={alternate.action} textValue={alternate.label}>
              {alternate.label}…
            </Dropdown.Item>
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>
    </div>
  );
});

const SpaceChat = observer(function SpaceChat({
  space,
  handle,
}: {
  space: Space;
  /** `C` / `M` on the page. */
  handle: MutableRefObject<ChatHandle | null>;
}) {
  const store = useRootStore();
  const [text, setText] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const messages = [
    ...store.models.chatMessages.byPr(spaceChatKey(space.id)),
  ].sort((a, b) => a.at - b.at);
  const run = space.status === 'running' ? space.run : null;
  const undone = undoneMessages(space);
  const undo = undoState(space);
  const checks = checksByReply(space.turn_log);
  const turnRuns = runsByReply(space.id, space.turn_log);
  // A finished turn's tool calls, kept for this session; the turn still
  // running (its check) shows them below instead.
  const turnTools = (reply: string) => {
    const r = turnRuns.get(reply);
    const tools = r && r !== run ? (store.ephemeral.runLog.get(r) ?? []) : [];
    return r && tools.length > 0 ? (
      <ToolCalls tools={tools} running={false} turn={r} />
    ) : null;
  };
  const setupStage = setupView(space) === 'stage';
  const streaming = run ? store.ephemeral.agentText.get(run) : undefined;
  const tools = run ? (store.ephemeral.runLog.get(run) ?? []) : [];
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end' });
  }, [messages.length, streaming]);

  // Sticky per space: the next turn starts in the space's last mode.
  const [mode, setMode] = useState<SpaceMode>(space.mode);
  useEffect(() => setMode(space.mode), [space.mode]);
  const locked = !!run || space.status === 'archived';
  handle.current = {
    focus: () => input.current?.focus(),
    cycleMode: () => !locked && setMode((m) => nextMode(m)),
  };

  const send = () => {
    const t = text.trim();
    if (!t || run || space.status === 'archived') return;
    setText('');
    void api
      .spaceSend({
        space: space.id,
        text: t,
        agent: null,
        model: null,
        mode: mode === space.mode ? null : mode,
      })
      .catch(() => setText(t));
  };

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        {/* Messages keep a reading width; the scroll area and the input
            strip below span the whole column. */}
        <div className="mx-auto flex w-full max-w-[860px] flex-col gap-4 px-5 py-4">
          <SetupStage space={space} />
          <SetupNote space={space} />
          {messages.length === 0 && !run && !setupStage && (
            <span className="text-sm text-muted">
              Tell the agent what to change. It works in its own worktree; your
              checkout is never touched.
            </span>
          )}
          {messages.map((m) => (
            <div
              key={m.id}
              className={`flex flex-col gap-1 ${undone.has(m.id) ? 'space-undone opacity-50' : ''}`}
            >
              <span className="flex items-center gap-1.5 text-xs text-muted">
                {m.author.kind === 'me' ? 'you' : m.author.agent}
                {undone.has(m.id) && m.author.kind === 'agent' && (
                  <span className="rounded-full bg-default px-1.5 text-[10px]">
                    undone
                  </span>
                )}
                {undo.turn?.reply === m.id && space.status !== 'archived' && (
                  <UndoTurn
                    space={space}
                    reason={undo.ok ? null : undo.reason}
                  />
                )}
              </span>
              {m.failed ? (
                <span className="text-sm text-danger [overflow-wrap:anywhere]">
                  {m.failed}
                </span>
              ) : (
                <div className="rich whitespace-pre-wrap text-sm leading-relaxed">
                  {m.author.kind === 'me' ? m.text : rich(m.text)}
                </div>
              )}
              {m.author.kind === 'agent' && turnTools(m.id)}
              {m.author.kind === 'agent' && checks.has(m.id) && (
                <CheckChip check={checks.get(m.id)!} />
              )}
            </div>
          ))}
          {run && (
            <div className="flex flex-col gap-1">
              <span className="flex items-center gap-2 text-xs text-muted">
                <Spinner /> {space.agent} is working
              </span>
              {tools.length > 0 && (
                <ToolCalls tools={tools} running turn={run} />
              )}
              {streaming && (
                <div className="rich whitespace-pre-wrap text-sm leading-relaxed">
                  {rich(streaming)}
                </div>
              )}
            </div>
          )}
          <div ref={end} />
        </div>
      </div>
      <div className="px-4 pb-3 pt-1">
        <div className="mx-auto flex w-full max-w-[860px] flex-col gap-2">
          {space.status === 'failed' && space.error && (
            <span
              className="truncate px-2 text-xs text-danger"
              title={space.error}
            >
              {space.error}
            </span>
          )}
          <Composer
            inputRef={input}
            value={text}
            onChange={setText}
            onSubmit={send}
            placeholder={
              space.status === 'archived'
                ? 'Archived'
                : settingUp(space)
                  ? 'Setting up…'
                  : 'Ask the agent to change something…'
            }
            disabled={space.status === 'archived' || settingUp(space)}
            running={!!run}
            onStop={() => void api.spaceStop(space.id).catch(() => {})}
            chips={
              <ChipMenu
                ariaLabel="Mode"
                label={MODES.find((m) => m.id === mode)?.label ?? mode}
                items={MODES}
                selected={mode}
                onSelect={setMode}
                isDisabled={locked}
              />
            }
          />
        </div>
      </div>
    </>
  );
});

/** Undo last turn, on the agent's reply that ended it. `reason` set:
 *  shown disabled with why (still running, already shipped…). */
function UndoTurn({ space, reason }: { space: Space; reason: string | null }) {
  const [busy, setBusy] = useState(false);
  return (
    <Tooltip>
      <Button
        size="sm"
        variant="ghost"
        className="space-undo h-5 gap-1 px-1.5 text-[11px]"
        isDisabled={reason != null}
        isPending={busy}
        onPress={() => {
          setBusy(true);
          void undoLastTurn(space).finally(() => setBusy(false));
        }}
      >
        <ArrowUturnCcwLeft className="size-3" />
        Undo
      </Button>
      <Tooltip.Content>
        {reason ?? 'Back to the checkpoint before this turn; the chat keeps it'}
      </Tooltip.Content>
    </Tooltip>
  );
}

const SpaceChanges = observer(function SpaceChanges({
  space,
}: {
  space: Space;
}) {
  const store = useRootStore();
  const review = space.review_pr;
  const summary = review ? store.models.prSummaries.get(review) : undefined;
  const revision =
    review && summary
      ? store.revisions.get(`${review}@${summary.head_sha}`, () =>
          api.getRevision({ pr: review, head: summary.head_sha }),
        )
      : null;
  const [focusHunk, setFocusHunk] = useState<HunkId | null>(null);
  const [composer, setComposer] = useState<ComposerState | null>(null);
  const setMode = useMemo(() => () => {}, []);
  const rev = revision?.status === 'ready' ? revision.data : null;
  return (
    <>
      <div className="flex items-center gap-3 border-b border-separator px-5 py-2.5 text-xs text-muted">
        <span className="tabular-nums text-foreground">
          {rev ? diffStat(rev.files) : '…'}
        </span>
        <span>
          vs {space.base} ·{' '}
          {space.turns ? `after turn ${space.turns}` : 'no turns yet'}
        </span>
        {space.status === 'running' && (
          <span>· refreshes when the turn ends</span>
        )}
      </div>
      {!review || !summary || !revision ? (
        <div className="grid flex-1 place-items-center text-muted">
          No changes yet.
        </div>
      ) : revision.status === 'error' ? (
        <div className="grid flex-1 place-items-center text-danger">
          Could not load the diff.
        </div>
      ) : !rev ? (
        <div className="grid flex-1 place-items-center text-muted">
          <Spinner />
        </div>
      ) : rev.files.length === 0 ? (
        <div className="grid flex-1 place-items-center text-muted">
          No changes yet.
        </div>
      ) : (
        <DiffPane
          pr={review}
          rev={rev}
          mode={WHOLE_DIFF}
          setMode={setMode}
          focusHunk={focusHunk}
          setFocusHunk={setFocusHunk}
          composer={composer}
          setComposer={setComposer}
          nextGroup={false}
        />
      )}
    </>
  );
});

/** New space: a composer, not a form — say what you want; the project,
 *  agent and base sit as chips around it. ⏎ creates and sends it as the
 *  first turn; the space opens on that turn. */
export const NewSpaceModal = observer(function NewSpaceModal() {
  const store = useRootStore();
  const ui = useUi();
  const ready = store.models.projects.where((p) => p.status === 'ready');
  const [project, setProject] = useState<string | null>(
    ui.workspace !== ALL && ready.some((p) => p.id === ui.workspace)
      ? ui.workspace
      : (ready[0]?.id ?? null),
  );
  const [goal, setGoal] = useState('');
  const [agent, setAgent] = useState<AgentChoice>('');
  const [busy, setBusy] = useState(false);
  const chosen = ready.find((p) => p.id === project);
  const start = async () => {
    if (!project || !goal.trim() || busy) return;
    setBusy(true);
    try {
      const { agent: a, model } = parseAgentChoice(agent);
      const s = await api.createSpace({
        project,
        goal: goal.trim(),
        name: null,
        branch: null,
        base: null,
        agent: a,
        model,
      });
      ui.closeModal();
      ui.go({ name: 'space', id: s.id });
    } catch {
      // toasted by api.ts
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal.Backdrop isOpen onOpenChange={(open) => !open && ui.closeModal()}>
      <Modal.Container placement="top" className="mt-[14vh]">
        <Modal.Dialog
          aria-label="New space"
          className="modal new-space flex w-[680px] max-w-[92vw] flex-col gap-3 p-3"
        >
          <header className="flex items-center gap-1.5 px-1 text-sm">
            {ready.length > 1 ? (
              <ChipMenu
                ariaLabel="Project"
                label={chosen ? chosen.repo.name : 'Project'}
                icon={<Folder className="size-3.5" />}
                items={ready.map((p) => ({
                  id: p.id,
                  label: p.repo.name,
                  hint: p.path ?? `${p.repo.owner}/${p.repo.name}`,
                }))}
                selected={project ?? ''}
                onSelect={setProject}
              />
            ) : (
              <span className="flex items-center gap-1.5 px-2 text-xs">
                <Folder className="size-3.5 text-muted" />
                {chosen?.repo.name}
              </span>
            )}
            <ChevronRight className="size-3 text-muted" />
            <span className="font-medium">New space</span>
            <span className="flex-1" />
            <Modal.CloseTrigger aria-label="Close" className="static" />
          </header>
          <Composer
            value={goal}
            onChange={setGoal}
            onSubmit={() => void start()}
            placeholder="What do you want to work on?"
            rows={5}
            autoFocus
            disabled={busy || !project}
            submit={busy ? 'Creating…' : 'Create'}
            chips={
              <>
                <AgentChip value={agent} onChange={setAgent} />
                {chosen?.default_branch && (
                  <span className="flex items-center gap-1 px-2 text-xs text-muted">
                    <BranchesRight className="size-3.5" />
                    from {chosen.default_branch}
                  </span>
                )}
              </>
            }
          />
          <span className="px-2 text-xs text-muted">
            The agent works in its own worktree — your checkout is never
            touched. <K>⇧⏎</K> new line.
          </span>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
});

/** Settings → Labs: the build mode switch, and the spaces' own settings. */
export const LabsPage = observer(function LabsPage() {
  const store = useRootStore();
  const on = isBuildMode(store);
  return (
    <section className="flex flex-col gap-2">
      <Card
        variant="secondary"
        className="flex flex-row items-center gap-3 px-4 py-3"
      >
        <Switch
          size="sm"
          aria-label="Spaces"
          isSelected={on}
          isDisabled={FEATURES.buildMode}
          onChange={(v) => setSetting(store, 'user', BUILD_MODE_KEY, v)}
        >
          <Switch.Content>
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
          </Switch.Content>
        </Switch>
        <span className="text-sm">
          Spaces in the sidebar, ⌥N for a new one. Off hides them everywhere;
          existing spaces stay on disk.
        </span>
      </Card>
      {on && (
        <Card variant="secondary" className="gap-0 p-0">
          <NumberSettingRow
            settingKey={AUTO_ARCHIVE_KEY}
            label="Auto-archive after (days)"
            hint="Days after a space's PR merges, or it is merged locally or kept as a branch, before it archives itself. 0 = never."
            placeholder={String(autoArchiveDays([]))}
            accept={(n) => n >= 0 && Number.isInteger(n)}
          />
          <div className="set-row flex items-center gap-4 px-4 py-3">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-sm font-medium">
                Notify when a turn ends
              </span>
              <span className="text-xs text-muted">
                A system notification when a space's turn finishes or fails
                while Theodore is in the background; the dock badge counts the
                spaces waiting for you.
              </span>
            </div>
            <Switch
              size="sm"
              aria-label="Notify when a turn ends"
              isSelected={notifyOn(store.models.settings.all())}
              onChange={(v) => setSetting(store, 'user', NOTIFY_KEY, v)}
            >
              <Switch.Content>
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
              </Switch.Content>
            </Switch>
          </div>
        </Card>
      )}
      {on && <GlobalConfigSection />}
    </section>
  );
});

/** One numeric user setting; empty clears it (the default applies). */
const NumberSettingRow = observer(function NumberSettingRow({
  settingKey,
  label,
  hint,
  prefix,
  placeholder,
  accept,
}: {
  settingKey: string;
  label: string;
  hint: string;
  prefix?: string;
  placeholder: string;
  accept: (n: number) => boolean;
}) {
  const store = useRootStore();
  const raw = store.models.settings.get(`user:${settingKey}`)?.value;
  const [text, setText] = useState(typeof raw === 'number' ? String(raw) : '');
  useEffect(() => {
    setText(typeof raw === 'number' ? String(raw) : '');
  }, [raw]);
  const save = () => {
    const t = text.trim();
    if (!t) {
      if (raw !== undefined) setSetting(store, 'user', settingKey, null);
      return;
    }
    const n = Number(t);
    if (Number.isFinite(n) && accept(n)) {
      setSetting(store, 'user', settingKey, n);
    }
  };
  return (
    <div className="set-row flex items-center gap-4 px-4 py-3">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-xs text-muted">{hint}</span>
      </div>
      <TextField
        value={text}
        onChange={setText}
        aria-label={label}
        className="w-32 shrink-0"
      >
        <InputGroup className="w-full rounded-xl">
          {prefix && (
            <InputGroup.Prefix className="text-xs text-muted">
              {prefix}
            </InputGroup.Prefix>
          )}
          <InputGroup.Input
            placeholder={placeholder}
            inputMode="decimal"
            className="w-full min-w-0 text-right text-sm"
            onBlur={save}
            onKeyDown={(e) => e.key === 'Enter' && save()}
          />
        </InputGroup>
      </TextField>
    </div>
  );
});
