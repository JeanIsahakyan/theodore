/**
 * Everything a space set going, in one strip above the composer
 * (docs/spaces.md "Seeing sub-spaces and agents", "Background tasks"): the
 * subagents of the current or last turn, its background tasks, and the
 * sub-spaces its agent started. Each thing is one row: a background subagent
 * of that turn is its turn row, with its task's status and Stop.
 *
 * ```text
 * ◌ 2 agents running · 1 sub-space · 1 command running ▾
 *   This turn
 *   ◌ Explore the auth flow   Sonnet 5  running in background  32s  [Stop] → its row
 *   ⚙ Review the tests        Haiku 5   done                  1m 4s
 *   Background
 *   ⌘ pnpm dev                                                 4m 2s  [Stop]
 *   Sub-spaces
 *   ◌ Fix the flaky test   ?   claude · Edit · 3 turns  waiting for you → opens it
 *   ✓ Update the docs          claude · Edit · 2 turns  merged   (muted, last)
 * ```
 *
 * A space mirrored from another computer lists the sub-spaces it started
 * there the same way (`remote_sub_space` rows): stage and mode, "runs on
 * <host> as a sub-space of <parent>" on hover, nothing to open.
 *
 * A sub-space's own page has `SubSpaceBanner` under its header: "Sub-space
 * of <parent> · started by its agent · merged back ✓" or "not merged yet".
 */
import { useEffect, useState, type RefObject } from 'react';
import {
  Check,
  ChevronDown,
  CircleQuestion,
  CircleXmark,
  CodeMerge,
  Cpu,
  Pencil,
} from '@gravity-ui/icons';
import { observer } from 'mobx-react-lite';
import type { AgentModel, Space, ToolPayload } from '../../gen/contract';
import { api } from '../../core/api';
import { useRootStore, useUi } from '../../stores/context';
import { modelName } from '../agentModel';
import { SpaceMark } from '../AgentMark';
import { Spinner } from '../bits';
import { pendingReveal, revealCall } from '../rowState';
import { formatDuration } from '../turnRows';
import { useAgentModels } from '../useAgentModels';
import { BackgroundTaskRow, StopTask, useNow } from './BackgroundTasks';
import { runningTasks, shownTasks } from './backgroundTaskRows';
import {
  backgroundRows,
  stripHeadline,
  subagentElapsed,
  subagentLive,
  subagentStatusLabel,
  subagentsOf,
  subagentTrouble,
  turnSource,
  type SubagentView,
} from './agents';
import { remoteOf, spaceChatKey, spaceTitle } from './spaces';
import {
  CHILD_STAGE_LABEL,
  childStage,
  everMerged,
  mergedIntoParent,
  nestRemoteSubs,
  parentId,
  remoteRoot,
  remoteStage,
  remoteSubPlace,
  subSpacesOf,
  type ChildStage,
  type RemoteSub,
  type StageFields,
} from './subspaces';
import type { VirtualChatControl } from './VirtualChat';

const MODE_LABEL: Record<Space['mode'], string> = {
  ask: 'Ask',
  plan: 'Plan',
  edit: 'Edit',
  run: 'Run',
};

/** "claude · Edit · 3 turns": what a sub-space runs, at a glance. */
export function subSpaceMeta(
  s: Pick<Space, 'agent' | 'mode' | 'turns'>,
): string {
  const turns = `${s.turns} turn${s.turns === 1 ? '' : 's'}`;
  return `${s.agent} · ${MODE_LABEL[s.mode]} · ${turns}`;
}

/** The word for where a sub-space stands: running → done → merged, or
 *  waiting for you, failed. */
export function subSpaceState(s: StageFields): string {
  return CHILD_STAGE_LABEL[childStage(s)];
}

// ── a subagent's model: from its call's payload, fetched once it shows ─────

const models = new Map<string, string | null>();

function modelOf(payload: ToolPayload | null): string | null {
  const ran = payload?.result?.resolved_model;
  if (ran) return ran;
  const input = payload?.input?.value;
  const asked =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>).model
      : null;
  return typeof asked === 'string' && asked ? asked : null;
}

/** The model a subagent ran on (or was asked to), once its payload says;
 *  a passive read, never toasted. */
function useSubagentModel(
  run: string | null,
  call: string,
  live: boolean,
): string | null {
  const key = run ? `${run}\u0000${call}` : null;
  const [got, setGot] = useState<{ key: string; model: string | null } | null>(
    null,
  );
  const known = key ? models.get(key) : undefined;
  useEffect(() => {
    if (!key || !run || known !== undefined) return;
    let on = true;
    void api
      .toolPayload(run, call, true)
      .then((p) => {
        const model = modelOf(p);
        // What a running one reports may still change at its result.
        if (!live || model) models.set(key, model);
        if (on) setGot({ key, model });
      })
      .catch(() => {});
    return () => {
      on = false;
    };
  }, [key, run, call, live, known]);
  if (known !== undefined) return known;
  return got?.key === key ? got.model : null;
}

// ── rows ───────────────────────────────────────────────────────────────────

const LINE =
  'flex w-full min-w-0 items-center gap-2 rounded-md px-1 py-0.5 text-left hover:bg-default';

export function SubagentLine({
  agent,
  space,
  run,
  now,
  remote,
  models,
  onOpen,
}: {
  agent: SubagentView;
  space: string;
  run: string | null;
  now: number;
  /** A remote space's payloads and tasks are its host's: no model read
   *  here, no Stop. */
  remote: boolean;
  /** The space's agent's catalog: what names a model id. */
  models: readonly AgentModel[] | undefined;
  onOpen: () => void;
}) {
  const live = subagentLive(agent);
  const model = useSubagentModel(remote ? null : run, agent.call, live);
  const elapsed = subagentElapsed(agent, now);
  const task = agent.task;
  return (
    <li
      data-status={agent.status}
      className="space-subagent flex min-w-0 items-center gap-2"
    >
      <button
        type="button"
        className={LINE}
        title={task?.note ?? agent.description}
        onClick={onOpen}
      >
        <span className="grid size-3.5 shrink-0 place-items-center text-muted">
          {live ? (
            <Spinner />
          ) : agent.status === 'failed' ? (
            <CircleXmark className="size-3 text-danger" />
          ) : (
            <Cpu className="size-3" />
          )}
        </span>
        <span className="min-w-0 flex-1 truncate">{agent.description}</span>
        {model && (
          <span
            className="space-subagent-model max-w-[30%] shrink-0 truncate text-muted"
            title={model}
          >
            {modelName(models, model)}
          </span>
        )}
        <span
          className={`shrink-0 ${subagentTrouble(agent) ? 'text-danger' : 'text-muted'}`}
        >
          {subagentStatusLabel(agent)}
        </span>
        {elapsed != null && (
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted">
            {formatDuration(elapsed)}
          </span>
        )}
      </button>
      {task?.status === 'running' && !remote && (
        <StopTask space={space} task={task} />
      )}
    </li>
  );
}

export const SubSpaceLine = observer(function SubSpaceLine({
  space,
  depth = 0,
  onOpen,
}: {
  space: Space;
  depth?: number;
  onOpen: () => void;
}) {
  const stage = childStage(space);
  const ask = stage === 'asking';
  const merged = stage === 'merged';
  return (
    <li
      data-status={space.status}
      data-stage={stage}
      className="space-subspace min-w-0"
    >
      <button
        type="button"
        className={LINE}
        style={
          depth ? { paddingInlineStart: `${depth * 14 + 4}px` } : undefined
        }
        title={spaceTitle(space)}
        onClick={onOpen}
      >
        <span className="grid size-3.5 shrink-0 place-items-center text-muted [&>svg]:size-3">
          <SpaceMark
            spaceId={space.id}
            size={14}
            fallback={
              space.status === 'failed' ? (
                <CircleXmark className="text-danger" />
              ) : stage === 'done' || merged ? (
                <Check />
              ) : (
                <Pencil />
              )
            }
          />
        </span>
        <span
          className={`min-w-0 flex-1 truncate ${merged ? 'text-muted' : ''}`}
        >
          {spaceTitle(space)}
        </span>
        {ask && (
          <CircleQuestion
            className="size-3 shrink-0 text-accent"
            aria-label="Waiting for your answer"
          />
        )}
        <span className="shrink-0 truncate text-muted">
          {subSpaceMeta(space)}
        </span>
        <span
          className={`space-subspace-stage shrink-0 ${stage === 'failed' ? 'text-danger' : ask ? 'text-accent' : 'text-muted'}`}
        >
          {CHILD_STAGE_LABEL[stage]}
        </span>
      </button>
    </li>
  );
});

/** A sub-space a mirrored space started on its host: its stage and mode,
 *  "runs on <host> as a sub-space of <parent>" on hover; nothing to open. */
export function RemoteSubSpaceLine({
  sub,
  place,
}: {
  sub: RemoteSub;
  place: string;
}) {
  const stage = remoteStage(sub);
  const ask = stage === 'asking';
  const merged = stage === 'merged';
  return (
    <li
      data-stage={stage}
      className="space-subspace space-remote-subspace min-w-0"
    >
      <div
        className="flex w-full min-w-0 items-center gap-2 rounded-md px-1 py-0.5"
        title={`${sub.title} · ${place}`}
      >
        <span className="grid size-3.5 shrink-0 place-items-center text-muted [&>svg]:size-3">
          <RemoteStageMark stage={stage} />
        </span>
        <span
          className={`min-w-0 flex-1 truncate ${merged ? 'text-muted' : ''}`}
        >
          {sub.title}
        </span>
        {ask && (
          <CircleQuestion
            className="size-3 shrink-0 text-accent"
            aria-label="Waiting for an answer"
          />
        )}
        <span className="shrink-0 truncate text-muted">
          {MODE_LABEL[sub.mode]}
        </span>
        <span
          className={`space-subspace-stage shrink-0 ${stage === 'failed' ? 'text-danger' : ask ? 'text-accent' : 'text-muted'}`}
        >
          {CHILD_STAGE_LABEL[stage]}
        </span>
      </div>
    </li>
  );
}

/** A remote sub-space's mark: no agent of it shows here, so its stage. */
export function RemoteStageMark({ stage }: { stage: ChildStage }) {
  switch (stage) {
    case 'running':
    case 'starting':
      return <Spinner />;
    case 'asking':
      return (
        <span
          className="size-2 rounded-full bg-accent"
          aria-label="Waiting for an answer"
        />
      );
    case 'failed':
      return <CircleXmark className="text-danger" aria-label="Failed" />;
    case 'merged':
      return <CodeMerge aria-label="Merged into its parent" />;
    case 'done':
      return <Check />;
    default:
      return <Pencil />;
  }
}

// ── the strip above the composer ────────────────────────────────────────────

/** Open or closed, per space, for as long as the window lives. */
const opened = new Map<string, boolean>();

function Section({ title }: { title: string }) {
  return <span className="px-1 pt-0.5 text-[11px] text-muted">{title}</span>;
}

export const SpaceAgents = observer(function SpaceAgents({
  space,
  log,
}: {
  space: Space;
  /** The chat above: a subagent's row is brought into view in it. */
  log?: RefObject<VirtualChatControl | null>;
}) {
  const store = useRootStore();
  const ui = useUi();
  const [open, setOpenState] = useState(() => opened.get(space.id) ?? false);
  const setOpen = (v: boolean) => {
    opened.set(space.id, v);
    setOpenState(v);
  };
  const remote = !!remoteOf(space);
  const messages = store.models.chatMessages.byPr(spaceChatKey(space.id));
  const source = turnSource(
    space,
    messages,
    (run) => store.ephemeral.runSteps.get(run),
    (id) => store.ephemeral.turnKeys.get(id) ?? id,
  );
  const run = source?.run ?? null;
  const agents = source
    ? subagentsOf(source.steps, {
        running: source.running,
        tasks: space.background_tasks,
        times: (call) => (run ? store.ephemeral.stepTime(run, call) : null),
      })
    : [];
  const subs = subSpacesOf(space.id, store.models.spaces.all());
  // A mirrored space's own sub-spaces run on its host: listed, not opened.
  const remoteSubs = remoteRoot(space)
    ? nestRemoteSubs(space.id, store.models.remoteSubSpaces.all()).map(
        (n) => n.sub,
      )
    : [];
  const stages = [...subs.map(childStage), ...remoteSubs.map(remoteStage)];
  const busy =
    agents.some(subagentLive) ||
    stages.some((g) => g === 'running' || g === 'asking') ||
    runningTasks(space).length > 0;
  // Tasks tick even closed: an ended one goes a few seconds after it ends.
  const now = useNow(
    (space.background_tasks?.length ?? 0) > 0 || (open && busy),
  );
  const background = backgroundRows(shownTasks(space, now), agents);
  const catalog = useAgentModels(agents.length && !remote ? [space.agent] : []);
  // Opened from the Agents view on one of these: its turn comes into view.
  useEffect(() => {
    const r = pendingReveal();
    if (!r || r.space !== space.id || !r.turn) return;
    const turn = r.turn;
    const frame = requestAnimationFrame(() =>
      log?.current?.scrollToKey(turn, 'start'),
    );
    return () => cancelAnimationFrame(frame);
  }, [space.id, log]);
  if (!agents.length && !background.length && !stages.length) return null;
  const reveal = (a: SubagentView) => {
    const turn = source?.turn ?? null;
    if (turn) log?.current?.scrollToKey(turn, 'start');
    revealCall({ call: a.call, space: space.id, turn });
  };
  return (
    <div
      className="space-agents flex min-w-0 flex-col gap-1 rounded-lg border border-separator px-3 py-1.5 text-xs"
      aria-label="Agents"
    >
      <button
        type="button"
        aria-expanded={open}
        data-busy={busy}
        className="flex min-w-0 items-center gap-2 text-left text-muted"
        onClick={() => setOpen(!open)}
      >
        {busy ? (
          <span className="inline-flex size-3 items-center justify-center">
            <Spinner />
          </span>
        ) : (
          <Cpu className="size-3 shrink-0" />
        )}
        <span className="min-w-0 truncate">
          {stripHeadline(agents, background, stages)}
        </span>
        <ChevronDown
          className={`ml-auto size-3 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <div className="flex flex-col gap-1 pb-0.5">
          {agents.length > 0 && (
            <>
              <Section title={source?.running ? 'This turn' : 'Last turn'} />
              <ul className="flex flex-col">
                {agents.map((a) => (
                  <SubagentLine
                    key={a.call}
                    agent={a}
                    space={space.id}
                    run={run}
                    now={now}
                    remote={remote}
                    models={catalog[space.agent]}
                    onOpen={() => reveal(a)}
                  />
                ))}
              </ul>
            </>
          )}
          {background.length > 0 && (
            <>
              <Section title="Background" />
              <ul className="flex flex-col">
                {background.map((t) => (
                  <BackgroundTaskRow
                    key={t.id}
                    space={space.id}
                    task={t}
                    now={now}
                    canStop={!remote}
                  />
                ))}
              </ul>
            </>
          )}
          {stages.length > 0 && (
            <>
              <Section title="Sub-spaces" />
              <ul className="flex flex-col">
                {subs.map((s) => (
                  <SubSpaceLine
                    key={s.id}
                    space={s}
                    onOpen={() => ui.go({ name: 'space', id: s.id })}
                  />
                ))}
                {remoteSubs.map((s) => (
                  <RemoteSubSpaceLine
                    key={s.id}
                    sub={s}
                    place={remoteSubPlace(
                      remoteOf(space)?.host_name ?? 'its host',
                      spaceTitle(space),
                    )}
                  />
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
});

/** Where a sub-space stands with its parent, in a slim strip under the
 *  header: "Sub-space of <parent> · started by its agent · merged back ✓"
 *  (or "not merged yet"). The parent's name opens it. A mirrored space's
 *  parent is its host's: no strip. */
export const SubSpaceBanner = observer(function SubSpaceBanner({
  space,
}: {
  space: Space;
}) {
  const store = useRootStore();
  const ui = useUi();
  const up = parentId(space);
  if (!up) return null;
  const parent = store.models.spaces.get(up);
  if (!parent && space.remote) return null;
  const merged = mergedIntoParent(space);
  const since = !merged && everMerged(space);
  return (
    <div
      className="space-subspace-banner flex min-w-0 shrink-0 items-center gap-1.5 border-b border-separator px-6 py-1 text-xs text-muted"
      data-merged={merged || undefined}
    >
      <span className="shrink-0">Sub-space of</span>{' '}
      {parent ? (
        <button
          type="button"
          className="space-parent min-w-0 truncate text-foreground hover:underline"
          title={`Open ${spaceTitle(parent)}`}
          onClick={() => ui.go({ name: 'space', id: parent.id })}
        >
          {spaceTitle(parent)}
        </button>
      ) : (
        <span className="space-parent min-w-0 truncate">a removed space</span>
      )}{' '}
      <span className="shrink-0">· started by its agent ·</span>{' '}
      {merged ? (
        <span className="space-merged inline-flex shrink-0 items-center gap-1">
          merged back
          <Check className="size-3" aria-hidden="true" />
        </span>
      ) : (
        <span className="space-merged shrink-0">
          {since ? 'changed since its last merge' : 'not merged yet'}
        </span>
      )}
    </div>
  );
});
