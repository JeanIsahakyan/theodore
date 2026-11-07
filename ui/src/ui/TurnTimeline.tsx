/**
 * A space turn as it happened: its text, tool calls and thinking as one flat
 * list, oldest first.
 *
 * ```text
 * running   rows, open and growing, a spinner on the newest
 *              │ the reply lands
 *              ▼
 * finished  Worked 1m 12s · 12 steps ▸   opens the same rows
 *           the reply
 *           copy · vote · 1m 12s · 14:03
 * ```
 */
import { memo, useState, type ComponentType, type ReactNode } from 'react';
import {
  Bulb,
  CircleXmarkFill,
  FileText,
  Magnifier,
  Pencil,
  Terminal,
  Wrench,
} from '@gravity-ui/icons';
import { Disclosure } from '@heroui/react';
import { observer } from 'mobx-react-lite';
import type { TurnStep } from '../gen/contract';
import { useRootStore } from '../stores/context';
import { Md } from '../highlight';
import { Spinner } from './bits';
import { toolRow, type ToolKind } from './toolSummary';

const KIND_ICON: Record<ToolKind, ComponentType<{ className?: string }>> = {
  read: FileText,
  edit: Pencil,
  run: Terminal,
  search: Magnifier,
  other: Wrench,
};

/** `<1s`, `42s`, `1m 12s`, `1h 3m`. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return '<1s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function StepIcon({ busy, children }: { busy: boolean; children: ReactNode }) {
  return (
    <span className="grid size-4 shrink-0 place-items-center text-muted">
      {busy ? <Spinner /> : children}
    </span>
  );
}

const ToolRow = memo(function ToolRow({
  step,
  busy,
}: {
  step: Extract<TurnStep, { kind: 'tool' }>;
  busy: boolean;
}) {
  const { kind, label } = toolRow(step.name);
  const Icon = KIND_ICON[kind];
  const failed = step.ok === false;
  return (
    <div
      data-kind={kind}
      className="turn-tool flex min-w-0 items-center gap-1.5 text-xs"
    >
      <StepIcon busy={busy}>
        <Icon className="size-3.5" />
      </StepIcon>
      <span className="shrink-0 text-muted">{label}</span>
      {step.target && (
        <span
          title={step.target}
          className="min-w-0 truncate rounded bg-default px-1.5 py-0.5 font-mono text-[11px] text-muted"
        >
          {step.target}
        </span>
      )}
      {failed && (
        <span className="turn-tool-failed inline-flex shrink-0 items-center gap-1 text-danger">
          <CircleXmarkFill className="size-3.5" />
          failed
        </span>
      )}
    </div>
  );
});

const ThinkingRow = memo(function ThinkingRow({
  text,
  busy,
}: {
  text: string;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <button
      type="button"
      aria-expanded={open}
      className="turn-thinking flex w-full min-w-0 items-start gap-1.5 text-left text-xs text-muted"
      onClick={() => setOpen((o) => !o)}
    >
      <StepIcon busy={busy}>
        <Bulb className="size-3.5" />
      </StepIcon>
      <span className="shrink-0">Thinking</span>
      <span
        className={
          open
            ? 'turn-thinking-text min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]'
            : 'turn-thinking-text min-w-0 truncate'
        }
      >
        {open ? text : text.replace(/\s+/g, ' ')}
      </span>
    </button>
  );
});

const TextRow = memo(function TextRow({ text }: { text: string }) {
  return (
    <div className="turn-text text-sm leading-relaxed">
      <Md text={text} />
    </div>
  );
});

/** The rows. `running`: the newest one spins. */
export function TimelineRows({
  steps,
  running = false,
}: {
  steps: readonly TurnStep[];
  running?: boolean;
}) {
  // A text piece that is only whitespace so far has nothing to show yet.
  const rows = steps.filter((s) => s.kind !== 'text' || s.text.trim());
  const newest = rows.at(-1);
  return (
    <div className="turn-timeline flex min-w-0 flex-col gap-2">
      {rows.map((step, i) => {
        const busy = running && i === rows.length - 1;
        return step.kind === 'text' ? (
          <TextRow key={i} text={step.text} />
        ) : step.kind === 'thinking' ? (
          <ThinkingRow key={i} text={step.text} busy={busy} />
        ) : (
          <ToolRow key={i} step={step} busy={busy} />
        );
      })}
      {/* Text has no icon to spin: the spinner goes under it. */}
      {running && newest?.kind === 'text' && <Spinner />}
    </div>
  );
}

/** A running turn's rows as they arrive. Its own observer: a piece of text
 *  re-renders this, not the chat around it. */
export const LiveTimeline = observer(function LiveTimeline({
  run,
  fallback = null,
}: {
  run: string;
  /** Shown until the first step arrives. */
  fallback?: ReactNode;
}) {
  const store = useRootStore();
  const steps = store.ephemeral.runSteps.get(run);
  if (!steps?.length) return <>{fallback}</>;
  return <TimelineRows steps={steps} running />;
});

/** Whether a reply's activity is open, by message id: kept across remounts
 *  (leaving the space and coming back), closed by default. */
const activityOpen = new Map<string, boolean>();

/** `Worked 1m 12s · 12 steps`. */
export function workedLine(steps: number, ms: number | null | undefined) {
  const count = `${steps} ${steps === 1 ? 'step' : 'steps'}`;
  return ms == null
    ? `Worked · ${count}`
    : `Worked ${formatDuration(ms)} · ${count}`;
}

/** A finished turn's activity, folded to one line above its reply. */
export function TurnActivity({
  reply,
  steps,
  durationMs,
}: {
  /** The reply's message id. */
  reply: string;
  steps: readonly TurnStep[];
  durationMs?: number | null;
}) {
  const [open, setOpen] = useState(() => activityOpen.get(reply) ?? false);
  const toggle = (next: boolean) => {
    activityOpen.set(reply, next);
    setOpen(next);
  };
  return (
    <Disclosure
      isExpanded={open}
      onExpandedChange={toggle}
      className="turn-activity"
    >
      <Disclosure.Heading>
        <Disclosure.Trigger className="turn-activity-summary flex w-fit items-center gap-1.5 text-left text-xs text-muted">
          <span>{workedLine(steps.length, durationMs)}</span>
          <Disclosure.Indicator />
        </Disclosure.Trigger>
      </Disclosure.Heading>
      <Disclosure.Content>
        {/* A turn can hold hundreds of rows: none of them while folded. */}
        <Disclosure.Body className="mt-2 border-l border-separator p-0 pl-3">
          {open && <TimelineRows steps={steps} />}
        </Disclosure.Body>
      </Disclosure.Content>
    </Disclosure>
  );
}

/** Beside a finished reply's actions: how long its turn ran, and when it
 *  ended. */
export function TurnFooter({
  at,
  durationMs,
}: {
  at: number;
  durationMs: number;
}) {
  const when = new Date(at);
  return (
    <span
      className="turn-footer text-xs text-muted"
      title={when.toLocaleString()}
    >
      {formatDuration(durationMs)} ·{' '}
      {when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
    </span>
  );
}
