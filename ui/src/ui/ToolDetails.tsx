/**
 * What opens under a tool row. Its row says what it did in one line; this is
 * the whole of it: the command and its output, what was read or searched, the
 * change as a diff, a tool's arguments and result, a subagent's prompt and
 * report. Only rendered while open (`toolPayload.ts`).
 *
 * ```text
 * Bash, shell      command · description · exit, time · output (stdout and
 *                  stderr apart only when both really hold something)
 * Read, Grep, …    arguments · the lines, matches or files
 * Edit, Write      file · − old / + new, or the written content
 * MCP, own tools   arguments and result as JSON
 * background       + while running / how it ended, and its final output
 * Agent            prompt · type, model · status · its steps · the report once
 * ```
 */
import { useState, type ReactNode } from 'react';
import { Check, Copy } from '@gravity-ui/icons';
import type {
  CappedText,
  SavedOutput,
  ToolOutcome,
  ToolPayload,
  TurnStep,
} from '../gen/contract';
import { Spinner } from './bits';
import { useToolPayload, type ToolPayloadState } from './toolPayload';
import { toolRow } from './toolSummary';
import { formatDuration, withoutReportStep, type ToolStep } from './turnRows';

const BLOCK =
  'turn-detail-text max-h-72 select-text overflow-auto whitespace-pre-wrap rounded-md bg-default/50 p-2 font-mono text-[11px] leading-relaxed [overflow-wrap:anywhere]';
const NOTE = 'text-xs text-muted';

type Input = Record<string, unknown>;

const text = (input: Input | null, key: string): string | null => {
  const value = input?.[key];
  return typeof value === 'string' && value ? value : null;
};

/** `3.4 MB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  return mb < 10 ? `${mb.toFixed(1)} MB` : `${Math.round(mb)} MB`;
}

/** A text's lines: a final newline ends the last one, it doesn't start
 *  another; nothing at all is no line. */
const linesOf = (text: string): string[] =>
  text === '' ? [] : text.replace(/\n$/, '').split('\n');

/** The change between two texts as whole lines: what they share at either
 *  end stays, the rest is removed and added, as the row's counts say. */
export function diffLines(
  before: string,
  after: string,
): { kind: ' ' | '-' | '+'; line: string }[] {
  const old = linesOf(before);
  const next = linesOf(after);
  let start = 0;
  while (start < old.length && old[start] === next[start]) start += 1;
  let end = 0;
  while (
    end < old.length - start &&
    end < next.length - start &&
    old[old.length - 1 - end] === next[next.length - 1 - end]
  ) {
    end += 1;
  }
  return [
    ...old.slice(0, start).map((line) => ({ kind: ' ' as const, line })),
    ...old
      .slice(start, old.length - end)
      .map((line) => ({ kind: '-' as const, line })),
    ...next
      .slice(start, next.length - end)
      .map((line) => ({ kind: '+' as const, line })),
    ...old
      .slice(old.length - end)
      .map((line) => ({ kind: ' ' as const, line })),
  ];
}

function pretty(value: unknown): string {
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  return JSON.stringify(value, null, 2);
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="turn-detail-copy grid size-5 shrink-0 place-items-center rounded text-muted hover:bg-default"
      onClick={() => {
        void navigator.clipboard?.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </button>
  );
}

function Section({
  title,
  copy,
  children,
}: {
  title: string;
  copy?: string;
  children: ReactNode;
}) {
  return (
    <section className="turn-detail flex min-w-0 flex-col gap-1">
      <div className="flex items-center gap-1 text-xs text-muted">
        <span className="min-w-0 truncate">{title}</span>
        {copy != null && (
          <CopyButton value={copy} label={`Copy ${title.toLowerCase()}`} />
        )}
      </div>
      {children}
    </section>
  );
}

/** Says a stored text was cut, and what it was. */
function CutNote({ bytes }: { bytes: number | null | undefined }) {
  if (bytes == null) return null;
  return (
    <div className={`turn-detail-cut ${NOTE}`}>
      Only part of this was kept: it was {formatBytes(bytes)}.
    </div>
  );
}

/** What a stream's block holds of output the CLI saved to a file. */
export function savedNote(saved: SavedOutput): string {
  const size = formatBytes(saved.bytes);
  switch (saved.kept) {
    case 'whole':
      return `The whole output: ${size}.`;
    case 'end':
      return `Only the end of this was kept: it was ${size}.`;
    case 'preview':
      return `Only part of this came through: it was ${size}, and its file couldn't be read.`;
  }
}

function OutputBlock({
  title,
  value,
  danger = false,
  note,
}: {
  title: string;
  value: CappedText;
  danger?: boolean;
  note?: string;
}) {
  return (
    <Section title={title} copy={value.text}>
      <pre className={`${BLOCK} ${danger ? 'text-danger' : ''}`}>
        {value.text}
      </pre>
      <CutNote bytes={value.original_bytes} />
      {note && <div className={`turn-detail-cut ${NOTE}`}>{note}</div>}
    </Section>
  );
}

function NotRecorded() {
  return (
    <div className={`turn-detail-missing ${NOTE}`}>
      The full output of this call wasn&apos;t recorded.
    </div>
  );
}

function Status({ children }: { children: ReactNode }) {
  return (
    <div className="turn-detail-status flex flex-wrap items-center gap-x-2 text-xs text-muted">
      {children}
    </div>
  );
}

const hasOutput = (result: ToolOutcome | null | undefined) =>
  !!result?.output?.text || !!result?.stdout?.text || !!result?.stderr?.text;

/** A result's output: separate streams when the stream gave them. */
function Output({ result, ok }: { result: ToolOutcome; ok: boolean | null }) {
  const failed = ok === false;
  if (!hasOutput(result)) {
    return <div className={NOTE}>No output.</div>;
  }
  // One combined stream when stderr is empty: nothing to tell apart.
  const apart = !!result.stdout?.text && !!result.stderr?.text;
  return (
    <>
      {result.stdout && (
        <OutputBlock
          title={apart ? 'Stdout' : 'Output'}
          value={result.stdout}
          note={result.saved ? savedNote(result.saved) : undefined}
        />
      )}
      {result.stderr && (
        <OutputBlock title="Stderr" value={result.stderr} danger={failed} />
      )}
      {result.output && (
        <OutputBlock
          title={failed ? 'Error' : 'Output'}
          value={result.output}
          danger={failed}
        />
      )}
    </>
  );
}

/** Its result, or that it's still running, never came, or wasn't kept. */
function ResultPart({
  step,
  running,
  payload,
}: {
  step: ToolStep;
  running: boolean;
  payload: ToolPayload | null;
}) {
  const result = payload?.result;
  if (result) return <Output result={result} ok={step.ok ?? null} />;
  if (step.ok == null) {
    return (
      <div className={NOTE}>
        {running ? 'Still running.' : 'No result came: the turn ended first.'}
      </div>
    );
  }
  return step.summary ? <div className={NOTE}>{step.summary}</div> : null;
}

/** It ended in the background: the result only says it started, and is
 *  stale beside what it ended with. */
const endedInBackground = (step: ToolStep, payload: ToolPayload | null) =>
  !!step.background && !!payload?.ended;

/** A background call: how it's doing, and what it ended with. */
function BackgroundPart({
  step,
  running,
  payload,
}: {
  step: ToolStep;
  running: boolean;
  payload: ToolPayload | null;
}) {
  const ended = payload?.ended;
  if (!ended) {
    return (
      <div className={NOTE}>
        {step.summary ??
          (running
            ? 'Running in the background: its output shows when it ends.'
            : "Ran in the background: the turn ended before it did, so there's no final output.")}
      </div>
    );
  }
  return (
    <>
      <Status>
        <span className="turn-detail-ended">Ended: {ended.status}</span>
        {ended.duration_ms != null && (
          <span>{formatDuration(ended.duration_ms)}</span>
        )}
      </Status>
      {ended.summary && <div className={NOTE}>{ended.summary}</div>}
      {ended.output && <OutputBlock title="Output" value={ended.output} />}
    </>
  );
}

function RunStatus({
  step,
  running,
  result,
}: {
  step: ToolStep;
  running: boolean;
  result: ToolOutcome | null | undefined;
}) {
  const parts: ReactNode[] = [];
  if (running && step.ok == null) parts.push(<span key="r">running</span>);
  if (step.background) parts.push(<span key="b">in background</span>);
  if (result?.exit_code != null) {
    parts.push(
      <span
        key="e"
        className={`turn-detail-exit ${result.exit_code ? 'text-danger' : ''}`}
      >
        exit {result.exit_code}
      </span>,
    );
  }
  if (result?.interrupted) parts.push(<span key="i">interrupted</span>);
  if (result?.duration_ms != null) {
    parts.push(<span key="d">{formatDuration(result.duration_ms)}</span>);
  }
  return parts.length > 0 ? <Status>{parts}</Status> : null;
}

/** The input as sent, or what the row still knows of it. */
function inputOf(payload: ToolPayload | null): Input | null {
  const value = payload?.input?.value;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Input)
    : null;
}

function CommandView({
  step,
  running,
  payload,
}: {
  step: ToolStep;
  running: boolean;
  payload: ToolPayload | null;
}) {
  const input = inputOf(payload);
  const command = text(input, 'command') ?? step.target;
  const description = text(input, 'description') ?? step.detail;
  return (
    <>
      {command != null && (
        <Section title="Command" copy={command}>
          <pre className={BLOCK}>{command}</pre>
        </Section>
      )}
      {description && <div className={NOTE}>{description}</div>}
      <CutNote bytes={payload?.input?.original_bytes} />
      <RunStatus step={step} running={running} result={payload?.result} />
      {step.background && (
        <BackgroundPart step={step} running={running} payload={payload} />
      )}
      {!endedInBackground(step, payload) && (
        <ResultPart step={step} running={running} payload={payload} />
      )}
    </>
  );
}

/** The arguments as `key: value` lines, the long ones whole. */
function Arguments({ input }: { input: Input }) {
  const entries = Object.entries(input);
  if (entries.length === 0) return null;
  return (
    <Section title="Arguments" copy={JSON.stringify(input, null, 2)}>
      <div className={BLOCK}>
        {entries.map(([key, value]) => (
          <div key={key}>
            <span className="text-muted">{key}: </span>
            {typeof value === 'string' ? value : JSON.stringify(value)}
          </div>
        ))}
      </div>
    </Section>
  );
}

function ReadOrSearchView({
  step,
  running,
  payload,
}: {
  step: ToolStep;
  running: boolean;
  payload: ToolPayload | null;
}) {
  const input = inputOf(payload);
  return (
    <>
      {input ? (
        <Arguments input={input} />
      ) : (
        step.target && <pre className={BLOCK}>{step.target}</pre>
      )}
      <CutNote bytes={payload?.input?.original_bytes} />
      <ResultPart step={step} running={running} payload={payload} />
    </>
  );
}

function DiffBlock({ before, after }: { before: string; after: string }) {
  const lines = diffLines(before, after);
  return (
    <div className={`turn-detail-diff ${BLOCK}`}>
      {lines.map((l, i) => (
        <div
          key={i}
          data-diff={l.kind}
          className={
            l.kind === '+'
              ? 'text-success'
              : l.kind === '-'
                ? 'text-danger'
                : 'text-muted'
          }
        >
          {l.kind} {l.line}
        </div>
      ))}
    </div>
  );
}

function EditView({
  step,
  running,
  payload,
}: {
  step: ToolStep;
  running: boolean;
  payload: ToolPayload | null;
}) {
  const input = inputOf(payload);
  const edits: { old_string?: unknown; new_string?: unknown }[] = Array.isArray(
    input?.edits,
  )
    ? (input.edits as { old_string?: unknown; new_string?: unknown }[])
    : [];
  const oldText = text(input, 'old_string');
  const newText = text(input, 'new_string');
  const written = text(input, 'content') ?? text(input, 'new_source');
  const path = text(input, 'file_path') ?? text(input, 'notebook_path');
  const failed = step.ok === false;
  const output = payload?.result?.output;
  const known = oldText != null || newText != null || !!written || edits.length;
  return (
    <>
      {(path ?? step.target) && (
        <div className={NOTE}>{path ?? step.target}</div>
      )}
      {oldText != null || newText != null ? (
        <Section title="Change">
          <DiffBlock before={oldText ?? ''} after={newText ?? ''} />
        </Section>
      ) : null}
      {edits.map((edit, i) => (
        <Section key={i} title={`Change ${i + 1}`}>
          <DiffBlock
            before={typeof edit.old_string === 'string' ? edit.old_string : ''}
            after={typeof edit.new_string === 'string' ? edit.new_string : ''}
          />
        </Section>
      ))}
      {written != null && (
        <Section title="Written" copy={written}>
          <pre className={BLOCK}>{written.replace(/\n$/, '')}</pre>
        </Section>
      )}
      {!known && input && <Arguments input={input} />}
      <CutNote bytes={payload?.input?.original_bytes} />
      {failed && output && <OutputBlock title="Error" value={output} danger />}
      {!known && !failed && (
        <ResultPart step={step} running={running} payload={payload} />
      )}
    </>
  );
}

/** Arguments and result, JSON pretty-printed: MCP and Theodore's own tools. */
function GenericView({
  step,
  running,
  payload,
}: {
  step: ToolStep;
  running: boolean;
  payload: ToolPayload | null;
}) {
  const input = payload?.input?.value;
  const result = payload?.result;
  const output = result?.output;
  return (
    <>
      {input !== undefined && input !== null ? (
        <Section title="Arguments" copy={pretty(input)}>
          <pre className={BLOCK}>{pretty(input)}</pre>
        </Section>
      ) : (
        step.target && <pre className={BLOCK}>{step.target}</pre>
      )}
      <CutNote bytes={payload?.input?.original_bytes} />
      {step.detail && <div className={NOTE}>{step.detail}</div>}
      {step.background && (
        <BackgroundPart step={step} running={running} payload={payload} />
      )}
      {endedInBackground(step, payload) ? null : result && output ? (
        <Section
          title={step.ok === false ? 'Error' : 'Result'}
          copy={output.text}
        >
          <pre className={`${BLOCK} ${step.ok === false ? 'text-danger' : ''}`}>
            {pretty(output.text)}
          </pre>
          <CutNote bytes={output.original_bytes} />
        </Section>
      ) : (
        <ResultPart step={step} running={running} payload={payload} />
      )}
    </>
  );
}

function Shell({
  state,
  step,
  children,
}: {
  state: ToolPayloadState;
  step: ToolStep;
  children: ReactNode;
}) {
  if (state.loading) {
    return (
      <div className="turn-detail-loading">
        <Spinner />
      </div>
    );
  }
  return (
    <>
      {children}
      {state.failed ? (
        <div className={NOTE}>Couldn&apos;t read the stored output.</div>
      ) : (
        !state.payload && step.ok != null && <NotRecorded />
      )}
    </>
  );
}

/** What opens under a tool row, chosen by the kind of tool it is. */
export function ToolDetails({
  step,
  running,
}: {
  step: ToolStep;
  running: boolean;
}) {
  const state = useToolPayload(step);
  const { kind } = toolRow(step.name);
  const view = { step, running, payload: state.payload };
  return (
    <div className="turn-tool-details mt-1.5 flex min-w-0 flex-col gap-1.5 ps-5">
      <Shell state={state} step={step}>
        {kind === 'run' ? (
          <CommandView {...view} />
        ) : kind === 'read' || kind === 'search' ? (
          <ReadOrSearchView {...view} />
        ) : kind === 'edit' ? (
          <EditView {...view} />
        ) : (
          <GenericView {...view} />
        )}
      </Shell>
    </div>
  );
}

/** What opens under a subagent's row: its prompt and what it is, then its
 *  own steps (`children`, as they nest) without the text its report repeats,
 *  then its report in full. */
export function AgentDetails({
  step,
  running,
  steps,
  children,
}: {
  step: ToolStep;
  running: boolean;
  /** The subagent's own steps. */
  steps: readonly TurnStep[];
  children: (shown: readonly TurnStep[]) => ReactNode;
}) {
  const state = useToolPayload(step);
  const input = inputOf(state.payload);
  const prompt = text(input, 'prompt');
  const type = text(input, 'subagent_type');
  // The model it really ran on; what it was asked to run on otherwise.
  const model = state.payload?.result?.resolved_model ?? text(input, 'model');
  const description = text(input, 'description') ?? step.detail;
  const status = agentStatus(step, running, state.payload);
  const report = state.payload?.report;
  const shown = report ? withoutReportStep(steps, report.text) : steps;
  return (
    <div className="turn-agent-details flex min-w-0 flex-col gap-2">
      {state.loading && <Spinner />}
      {(type || model || status) && (
        <Status>
          {type && <span className="turn-detail-type">{type}</span>}
          {model && <span className="turn-detail-model">{model}</span>}
          {status && <span className="turn-detail-agent-status">{status}</span>}
        </Status>
      )}
      {description && prompt && <div className={NOTE}>{description}</div>}
      {prompt && (
        <Section title="Prompt" copy={prompt}>
          <pre className={BLOCK}>{prompt}</pre>
          <CutNote bytes={state.payload?.input?.original_bytes} />
        </Section>
      )}
      {children(shown)}
      {report ? (
        <Section title="Report" copy={report.text}>
          <pre className={`turn-agent-summary ${BLOCK}`}>{report.text}</pre>
          <CutNote bytes={report.original_bytes} />
        </Section>
      ) : (
        !running &&
        step.summary && (
          <div className="turn-agent-summary text-xs text-muted">
            {step.summary}
          </div>
        )
      )}
      {!state.loading && !state.payload && step.ok != null && !state.failed && (
        <NotRecorded />
      )}
    </div>
  );
}

function agentStatus(
  step: ToolStep,
  running: boolean,
  payload: ToolPayload | null,
): string | null {
  const waiting = !!step.background && !step.summary;
  if (running && (step.ok == null || waiting)) {
    return waiting ? 'running in background' : 'running';
  }
  if (payload?.ended) return payload.ended.status;
  if (step.background && !step.summary) return 'ran in background';
  if (step.ok === false) return 'failed';
  return step.ok ? 'done' : null;
}
