/** A run's log, folded for reading. The core sends one line per event:
 *  `tool: <name>` for a call (optionally `tool: <name> · <target>` when it
 *  knows the command or file), `tool result ok=<bool>` after it, and plain
 *  notes like `stalled`. A build turn makes dozens of calls, mostly the
 *  same tool back to back — this collapses them into runs and totals. */

/** Consecutive calls of one tool, or a note line kept as-is. */
export type ToolGroup =
  | {
      kind: 'tool';
      tool: string;
      count: number;
      /** The latest call's target (command, file), truncated; null if the
       *  log didn't carry one. */
      target: string | null;
      failed: number;
    }
  | { kind: 'note'; text: string };

export type ToolSummary = {
  /** Tool calls so far. */
  steps: number;
  groups: ToolGroup[];
  /** Calls per tool, in first-seen order. */
  totals: { tool: string; count: number }[];
  /** The newest call — what the agent is doing right now. */
  latest: { tool: string; target: string | null } | null;
};

const TOOL = 'tool: ';
const RESULT = /^tool result ok=(true|false)$/;
const TARGET_SEP = ' · ';
export const TARGET_MAX = 60;

const clip = (s: string) =>
  s.length > TARGET_MAX ? `${s.slice(0, TARGET_MAX - 1)}…` : s;

function parseCall(line: string): { tool: string; target: string | null } {
  const rest = line.slice(TOOL.length).trim();
  const at = rest.indexOf(TARGET_SEP);
  if (at < 0) return { tool: rest, target: null };
  const target = rest
    .slice(at + TARGET_SEP.length)
    .replace(/\s+/g, ' ')
    .trim();
  return {
    tool: rest.slice(0, at).trim(),
    target: target ? clip(target) : null,
  };
}

export function summarizeTools(lines: readonly string[]): ToolSummary {
  const groups: ToolGroup[] = [];
  const totals = new Map<string, number>();
  let latest: ToolSummary['latest'] = null;
  let steps = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const result = RESULT.exec(line);
    if (result) {
      // A result belongs to the call before it; a success is noise.
      const last = groups.at(-1);
      if (result[1] === 'false' && last?.kind === 'tool') last.failed += 1;
      continue;
    }
    if (!line.startsWith(TOOL)) {
      groups.push({ kind: 'note', text: line });
      continue;
    }
    const call = parseCall(line);
    if (!call.tool) continue;
    steps += 1;
    latest = call;
    totals.set(call.tool, (totals.get(call.tool) ?? 0) + 1);
    const last = groups.at(-1);
    if (last?.kind === 'tool' && last.tool === call.tool) {
      last.count += 1;
      last.target = call.target ?? last.target;
    } else {
      groups.push({ kind: 'tool', ...call, count: 1, failed: 0 });
    }
  }
  return {
    steps,
    groups,
    totals: [...totals].map(([tool, count]) => ({ tool, count })),
    latest,
  };
}

/** `Bash ×12`, or just `Bash` for one call. */
export const times = (tool: string, count: number) =>
  count > 1 ? `${tool} ×${count}` : tool;

/** A finished turn in one line: `Used Bash ×12, Edit ×4, Read ×7`. Past
 *  `max` tools the tail folds into `+N more`. */
export function usedLine(s: ToolSummary, max = 5): string {
  if (!s.totals.length) return '';
  const shown = s.totals.slice(0, max).map((t) => times(t.tool, t.count));
  const rest = s.totals.length - shown.length;
  return `Used ${shown.join(', ')}${rest > 0 ? `, +${rest} more` : ''}`;
}

/** What the agent is doing now: `Running Bash · npm test…`. Theodore's own
 *  tools already log as phrases (`read the PR`), so those read as-is. */
export function runningLine(latest: NonNullable<ToolSummary['latest']>) {
  const phrase = /^[a-z]/.test(latest.tool) && latest.tool.includes(' ');
  const head = phrase
    ? latest.tool[0]!.toUpperCase() + latest.tool.slice(1)
    : `Running ${latest.tool}`;
  return `${head}${latest.target ? `${TARGET_SEP}${latest.target}` : ''}…`;
}
