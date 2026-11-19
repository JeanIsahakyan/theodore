/**
 * The Agents view (docs/spaces.md "Seeing sub-spaces and agents"): everything
 * running right now, across spaces. One card per tree of spaces with
 * something going in it; each lists its turn's subagents, its background
 * tasks, then its sub-spaces the same way, one step in.
 *
 * ```text
 * Agents  2
 * ┌ ◌ Fix the login redirect        api · claude · Edit · 4 turns   running
 * │   ◌ Explore the auth flow          sonnet   running   32s
 * │   ⌘ pnpm test --watch              running in background  1m 2s
 * │   ┌ ◌ Fix the flaky test   ?       claude · Edit · 1 turn   waiting for you
 * │   │   ◌ Read the CI logs            running   8s
 * └   └
 * ```
 *
 * A space's row opens it; a subagent's opens the space on its timeline row.
 */
import { Cpu, Cpus, Terminal } from '@gravity-ui/icons';
import { observer } from 'mobx-react-lite';
import type { BackgroundTask } from '../../gen/contract';
import { useRootStore, useUi } from '../../stores/context';
import { Empty } from '../bits';
import { ViewHeader } from '../List';
import { revealCall } from '../rowState';
import { formatDuration } from '../turnRows';
import { useNow } from './BackgroundTasks';
import { activeTrees, runningSpaces, subagentsOf, turnSource } from './agents';
import { SubagentLine, SubSpaceLine } from './SpaceAgents';
import { remoteOf, spaceChatKey } from './spaces';
import type { SpaceNode } from './subspaces';

export const AgentsPage = observer(function AgentsPage() {
  const store = useRootStore();
  const all = store.models.spaces.all();
  const trees = activeTrees(all);
  const now = useNow(trees.length > 0);
  return (
    <div className="view agents-page flex min-w-0 flex-1 flex-col">
      <ViewHeader title="Agents" count={runningSpaces(all) || undefined} />
      {trees.length === 0 ? (
        <Empty
          icon={<Cpus />}
          title="No agents running"
          text="Running turns, their subagents and background tasks, and the sub-spaces they start show here."
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto px-6 py-4">
          <ul className="mx-auto flex w-full max-w-[860px] flex-col gap-3">
            {trees.map((n) => (
              <li
                key={n.space.id}
                className="agents-tree rounded-lg border border-separator px-2 py-1.5 text-xs"
              >
                <SpaceBranch node={n} depth={0} now={now} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
});

/** A space's row, what its agent is running, then its sub-spaces. */
const SpaceBranch = observer(function SpaceBranch({
  node,
  depth,
  now,
}: {
  node: SpaceNode;
  depth: number;
  now: number;
}) {
  const store = useRootStore();
  const ui = useUi();
  const s = node.space;
  const open = () => ui.go({ name: 'space', id: s.id });
  const messages = store.models.chatMessages.byPr(spaceChatKey(s.id));
  // Only a running turn's subagents: the view is about now.
  const source =
    s.status === 'running'
      ? turnSource(
          s,
          messages,
          (run) => store.ephemeral.runSteps.get(run),
          (id) => store.ephemeral.turnKeys.get(id) ?? id,
        )
      : null;
  const run = source?.run ?? null;
  const agents = source
    ? subagentsOf(source.steps, {
        running: true,
        tasks: s.background_tasks,
        times: (call) => (run ? store.ephemeral.stepTime(run, call) : null),
      })
    : [];
  const shown = new Set(agents.map((a) => a.call));
  // Background work the subagent rows don't already show.
  const tasks = (s.background_tasks ?? []).filter(
    (t) => t.status === 'running' && !(t.call && shown.has(t.call)),
  );
  const indent = { paddingInlineStart: `${(depth + 1) * 14 + 4}px` };
  return (
    <>
      <ul className="flex flex-col">
        <SubSpaceLine space={s} depth={depth} onOpen={open} />
      </ul>
      {(agents.length > 0 || tasks.length > 0) && (
        <ul className="flex flex-col" style={indent}>
          {agents.map((a) => (
            <SubagentLine
              key={a.call}
              agent={a}
              run={run}
              now={now}
              fetchModel={!remoteOf(s)}
              onOpen={() => {
                revealCall({ call: a.call, space: s.id, turn: source?.turn });
                open();
              }}
            />
          ))}
          {tasks.map((t) => (
            <TaskLine
              key={t.id}
              task={t}
              now={now}
              onOpen={() => {
                if (t.call) revealCall({ call: t.call, space: s.id });
                open();
              }}
            />
          ))}
        </ul>
      )}
      {node.children.map((c) => (
        <SpaceBranch key={c.space.id} node={c} depth={depth + 1} now={now} />
      ))}
    </>
  );
});

function TaskLine({
  task,
  now,
  onOpen,
}: {
  task: BackgroundTask;
  now: number;
  onOpen: () => void;
}) {
  const Icon = task.kind === 'subagent' ? Cpu : Terminal;
  return (
    <li className="agents-task min-w-0">
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-2 rounded-md px-1 py-0.5 text-left hover:bg-default"
        title={task.description}
        onClick={onOpen}
      >
        <span className="grid size-3.5 shrink-0 place-items-center text-muted">
          <Icon className="size-3" />
        </span>
        <span className="min-w-0 flex-1 truncate">{task.description}</span>
        <span className="shrink-0 text-muted">running in background</span>
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted">
          {formatDuration(Math.max(0, now - task.started_at))}
        </span>
      </button>
    </li>
  );
}
