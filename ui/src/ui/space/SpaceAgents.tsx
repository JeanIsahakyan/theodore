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
 *   ◌ Fix the flaky test   ?   claude · Edit · 3 turns  → opens it
 * ```
 */
import { useEffect, useState, type RefObject } from 'react';
import {
  ChevronDown,
  CircleQuestion,
  CircleXmark,
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
import { asking, fromLabel, parentId, subSpacesOf } from './subspaces';
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

/** The word for where a sub-space stands, `null` while idle. */
export function subSpaceState(
  s: Pick<Space, 'status' | 'question'>,
): string | null {
  if (asking(s)) return 'waiting for you';
  if (s.status === 'running') return 'running';
  if (s.status === 'failed') return 'failed';
  return null;
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
  const state = subSpaceState(space);
  const ask = asking(space);
  return (
    <li data-status={space.status} className="space-subspace min-w-0">
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
              ) : (
                <Pencil />
              )
            }
          />
        </span>
        <span className="min-w-0 flex-1 truncate">{spaceTitle(space)}</span>
        {ask && (
          <CircleQuestion
            className="size-3 shrink-0 text-accent"
            aria-label="Waiting for your answer"
          />
        )}
        <span className="shrink-0 truncate text-muted">
          {subSpaceMeta(space)}
        </span>
        {state && (
          <span
            className={`shrink-0 ${space.status === 'failed' ? 'text-danger' : ask ? 'text-accent' : 'text-muted'}`}
          >
            {state}
          </span>
        )}
      </button>
    </li>
  );
});

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
  const busy =
    agents.some(subagentLive) ||
    subs.some((s) => s.status === 'running') ||
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
  if (!agents.length && !background.length && !subs.length) return null;
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
          {stripHeadline(agents, background, subs)}
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
          {subs.length > 0 && (
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
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
});

/** "from <parent>" beside a sub-space's name: opens the space that started
 *  it; plain text when that one is gone. */
export const ParentLink = observer(function ParentLink({
  space,
}: {
  space: Space;
}) {
  const store = useRootStore();
  const ui = useUi();
  const up = parentId(space);
  if (!up) return null;
  const parent = store.models.spaces.get(up);
  const label = fromLabel(space, parent ? [parent] : []);
  if (!label) return null;
  if (!parent) {
    return (
      <span className="space-parent shrink-0 truncate text-xs text-muted">
        {label}
      </span>
    );
  }
  return (
    <button
      type="button"
      className="space-parent min-w-0 max-w-[40%] shrink truncate text-xs text-muted hover:text-foreground hover:underline"
      title={`Started by the agent of ${spaceTitle(parent)}`}
      onClick={() => ui.go({ name: 'space', id: parent.id })}
    >
      {label}
    </button>
  );
});
