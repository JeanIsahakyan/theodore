/**
 * A local-space tool call in the parent's timeline (docs/spaces.md "Seeing
 * sub-spaces and agents"): what the agent did with which space, by name, and
 * where a started child stands, live. What it says is `spaceTools.ts`; the
 * call's input and result come from its payload, read as soon as the row
 * shows (a turn has few of these).
 *
 * ```text
 * ⑂ Sub-space started: Port the parser  ◌ running  Edit          ›
 * ⧗ Waiting for 3 sub-spaces  1 done · 2 running                 ›
 * ⑃ Merged Port the parser  4 files +120 −8  2 conflicts to resolve ›
 * ? Asked Fix the login: which store holds sessions?             ›  answer
 * ```
 *
 * A name opens its space; anywhere else on the row opens the details.
 */
import type { ComponentType } from 'react';
import {
  Check,
  CircleQuestion,
  CircleStop,
  CodeFork,
  CodeMerge,
  Comment,
  Eye,
  Hourglass,
  ListUl,
  PaperPlane,
} from '@gravity-ui/icons';
import { observer } from 'mobx-react-lite';
import { countUse } from '../core/useCounts';
import { Md } from '../highlight';
import { useRootStore, useUi } from '../stores/context';
import { Spinner } from './bits';
import { useKeptOpen, useSteadyChange } from './rowState';
import {
  askAnswer,
  mergedFiles,
  spaceToolData,
  spaceToolLine,
  spaceToolOf,
  spaceToolView,
  stageWord,
  type SpaceRef,
  type SpaceTool,
  type SpaceToolData,
  type SpaceToolView,
} from './spaceTools';
import type { ChildStage } from './space/subspaces';
import { BLOCK, NOTE, Section, ToolDetails } from './ToolDetails';
import { toolKey, useToolPayload, useToolRun } from './toolPayload';
import { Chevron, Failed, LineCounts, ROW, StepIcon } from './turnBits';
import { stepFailed, type ToolStep } from './turnRows';

const ICON: Record<SpaceTool, ComponentType<{ className?: string }>> = {
  start: CodeFork,
  wait: Hourglass,
  merge: CodeMerge,
  ask: CircleQuestion,
  send: PaperPlane,
  answer: Comment,
  read: Eye,
  list: ListUl,
  stop: CircleStop,
};

/** A space's name: opens it when it's here. */
const SpaceName = observer(function SpaceName({
  space,
  after,
}: {
  space: SpaceRef;
  /** Kept with the name, no gap: `:`, `'s question`. */
  after: string;
}) {
  const ui = useUi();
  const id = space.id;
  if (!space.known || !id) {
    return (
      <span
        className="turn-space-name min-w-0 max-w-[50%] shrink-0 truncate"
        title={space.title}
      >
        {space.title}
        {after}
      </span>
    );
  }
  return (
    // The name keeps up to half the row; the text after it gives way first.
    <span className="turn-space-name inline-flex min-w-0 max-w-[50%] shrink-0 items-center">
      <button
        type="button"
        className="min-w-0 truncate font-medium hover:underline"
        title={`Open ${space.title}`}
        onClick={(e) => {
          // The name opens the space; the row's own click opens details.
          e.stopPropagation();
          ui.go({ name: 'space', id });
        }}
      >
        {space.title}
      </button>
      {after && <span className="shrink-0">{after}</span>}
    </span>
  );
});

/** A started child's stage, as the strip and sidebar word it. */
export function StageChip({ stage }: { stage: ChildStage }) {
  const tone =
    stage === 'failed'
      ? 'text-danger'
      : stage === 'asking'
        ? 'text-accent'
        : 'text-muted';
  return (
    <span
      data-stage={stage}
      className={`turn-space-stage inline-flex shrink-0 items-center gap-1 rounded-full bg-default px-1.5 py-0.5 text-[11px] ${tone}`}
    >
      {stage === 'running' && <Spinner />}
      {stage === 'merged' && <Check className="size-3" />}
      {stageWord(stage)}
    </span>
  );
}

/** An ask, opened: the question and the answer. */
function AskDetails({
  view,
  data,
}: {
  view: SpaceToolView;
  data: SpaceToolData;
}) {
  const question =
    typeof data.input?.question === 'string' ? data.input.question : null;
  const got = askAnswer(data.result);
  return (
    <>
      {question && (
        <Section title="Question" copy={question}>
          <pre className={BLOCK}>{question}</pre>
        </Section>
      )}
      {got ? (
        <Section title="Answer" copy={got.answer}>
          <div className="turn-space-answer text-xs leading-relaxed">
            <Md text={got.answer} />
          </div>
          {got.by && <div className={NOTE}>{got.by}</div>}
        </Section>
      ) : (
        view.phase === 'running' && (
          <div className={NOTE}>Waiting for its answer.</div>
        )
      )}
    </>
  );
}

/** A merge, opened: each file with its lines, conflicts marked, and what
 *  to do next. */
function MergeDetails({ data }: { data: SpaceToolData }) {
  const files = mergedFiles(data.result);
  const note = typeof data.result?.note === 'string' ? data.result.note : null;
  return (
    <>
      {files.length > 0 && (
        <ul className="turn-space-files flex flex-col gap-0.5 text-xs">
          {files.map((f) => (
            <li
              key={f.path}
              data-conflict={f.conflict || undefined}
              className="flex min-w-0 items-center gap-1.5"
            >
              <span className="min-w-0 truncate font-mono text-[11px]">
                {f.path}
              </span>
              <LineCounts added={f.additions} removed={f.deletions} />
              {f.conflict && (
                <span className="shrink-0 text-warning">conflict</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {note && <div className={NOTE}>{note}</div>}
    </>
  );
}

const Details = observer(function Details({
  step,
  running,
  view,
  data,
}: {
  step: ToolStep;
  running: boolean;
  view: SpaceToolView;
  data: SpaceToolData;
}) {
  const custom =
    (view.tool === 'ask' && (view.phase !== 'failed' || data.result)) ||
    (view.tool === 'merge' && view.phase === 'done' && data.result);
  if (!custom) return <ToolDetails step={step} running={running} />;
  return (
    <div className="turn-tool-details mt-1.5 flex min-w-0 flex-col gap-1.5 ps-5">
      {view.tool === 'ask' ? (
        <AskDetails view={view} data={data} />
      ) : (
        <MergeDetails data={data} />
      )}
    </div>
  );
});

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

export const SpaceToolRow = observer(function SpaceToolRow({
  step,
  running,
}: {
  step: ToolStep;
  running: boolean;
}) {
  const store = useRootStore();
  const tool = spaceToolOf(step.name)!;
  const state = useToolPayload(step);
  const data = spaceToolData(state.payload);
  const view = spaceToolView(
    tool,
    step,
    data,
    (id) => store.models.spaces.get(id),
    running,
  );
  const key = toolKey(useToolRun(), step);
  const [open, setOpen] = useKeptOpen(key && `tool:${key}`);
  const steady = useSteadyChange();
  const toggle = () => {
    if (!open) countUse('tool_rows');
    steady(() => setOpen(!open));
  };
  const Icon = ICON[tool];
  const named = !!view.space;
  return (
    <div
      data-kind="space"
      data-tool={tool}
      data-phase={view.phase}
      className="turn-tool turn-space-tool min-w-0"
    >
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        title={spaceToolLine(view)}
        className={`turn-tool-line cursor-pointer ${ROW}`}
        onClick={() => {
          if (window.getSelection()?.isCollapsed === false) return;
          toggle();
        }}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          toggle();
        }}
      >
        <StepIcon busy={view.phase === 'running'}>
          <Icon className="size-3.5" />
        </StepIcon>
        <span className="turn-tool-label shrink-0">
          {view.label}
          {tool === 'start' && named ? ':' : ''}
        </span>
        {view.space && (
          <SpaceName
            space={view.space}
            after={`${view.after ?? ''}${view.text ? ':' : ''}`}
          />
        )}
        {view.text && (
          <span
            title={view.text}
            className="turn-space-text min-w-0 flex-1 truncate text-xs text-muted"
          >
            {view.text}
          </span>
        )}
        {view.stage && <StageChip stage={view.stage} />}
        {view.note && (
          <span
            title={view.note}
            className="turn-tool-note min-w-0 truncate text-xs text-muted"
          >
            {view.note}
          </span>
        )}
        <LineCounts added={view.added} removed={view.removed} />
        {view.conflicts > 0 && (
          <span className="turn-space-conflicts shrink-0 text-xs text-warning">
            {plural(view.conflicts, 'conflict')} to resolve
          </span>
        )}
        {stepFailed(step) && <Failed />}
        <Chevron open={open} />
      </div>
      {open && (
        <Details step={step} running={running} view={view} data={data} />
      )}
    </div>
  );
});
