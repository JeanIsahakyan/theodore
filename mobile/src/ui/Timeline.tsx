/**
 * A space turn as it happened: its text, tool calls, subagents and thinking,
 * oldest first, like the desktop's `TurnTimeline`, drawn the chat
 * template's way: the agent's words as full-width markdown, everything else
 * a compact grey row that opens in place. What folds is `turnRows.ts`; a
 * row stays open while the chat scrolls.
 *
 * ```text
 * running   rows growing, a spinner on each call still going,
 *           the text being written with a cursor▌, "Thinking" shimmering
 * finished  › 3 tool calls, 5 messages  ▤ ▸_      opens in place
 *           ▸_ Run  cargo test  ⓘ failed           always a row
 *           ▤ Read  .context/shot.png
 *             [ 🖼 thumbnail ]                      an image read: shown at once
 *                                                   (StepThumbnail, stepImages.ts)
 * ```
 *
 * A step's text or output (open) long-presses for Copy / Select text.
 */
import { memo, useMemo, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  LongPressMenu,
  Shimmer,
  StepThumbnail,
  StreamingMessage,
} from '../components/chat';
import { ChatMarkdown } from '../components/markdown';
import { SymbolImage, type SymbolName } from '../components/symbol-image';
import type { TurnStep } from '../fleet/contract';
import { Spinner } from './Spinner';
import { imageReadOf } from './stepImages';
import { mono, usePalette } from './theme';
import {
  foldLine,
  groupLabel,
  splitSteps,
  stepFailed,
  toolRow,
  toolView,
  turnItems,
  withoutReportStep,
  type FoldOptions,
  type ToolKind,
  type ToolStep,
  type TurnItem,
} from './turnRows';

/** An icon per kind of tool: SF Symbols, Material Symbols, Lucide. */
export const KIND_ICON: Record<ToolKind, SymbolName> = {
  read: 'step.read',
  edit: 'step.edit',
  run: 'step.run',
  search: 'step.search',
  agent: 'step.agent',
  mcp: 'step.mcp',
  other: 'step.other',
};

/** The phone's text isn't `selectable`: a long press opens the menu
 *  (`LongPressMenu`); on the web the DOM text selects as it is. */
const selectable = process.env.EXPO_OS === 'web';

const NO_STEPS: readonly TurnStep[] = [];
const NOTHING_UNDER = new Map<string, TurnStep[]>();

/** What's open, by row: a row scrolled away and back keeps it. */
const opened = new Map<string, boolean>();
const OPENED_MAX = 2000;

function useKeptOpen(key: string | null): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => (key ? !!opened.get(key) : false));
  return [
    open,
    (next) => {
      if (key) {
        if (opened.size > OPENED_MAX) opened.clear();
        opened.set(key, next);
      }
      setOpen(next);
    },
  ];
}

function Icon({ busy, name }: { busy: boolean; name: SymbolName }) {
  const p = usePalette();
  return (
    <View style={styles.icon}>
      {busy ? (
        <Spinner color={p.muted} />
      ) : (
        <SymbolImage name={name} size={13} color={p.muted} />
      )}
    </View>
  );
}

function Chevron({ open }: { open: boolean }) {
  const p = usePalette();
  return (
    <SymbolImage
      name="chevron.right"
      size={10}
      color={p.muted}
      style={{ transform: [{ rotate: open ? '90deg' : '0deg' }] }}
    />
  );
}

function Chip({ text }: { text: string }) {
  const p = usePalette();
  return (
    <Text
      numberOfLines={1}
      style={[
        mono,
        styles.chip,
        { backgroundColor: p.surfaceMuted, color: p.muted },
      ]}
    >
      {text}
    </Text>
  );
}

function Counts({
  added,
  removed,
}: {
  added: number | null | undefined;
  removed: number | null | undefined;
}) {
  const p = usePalette();
  return (
    <>
      {added != null ? (
        <Text style={[mono, styles.count, { color: p.success }]}>+{added}</Text>
      ) : null}
      {removed != null ? (
        <Text style={[mono, styles.count, { color: p.danger }]}>
          −{removed}
        </Text>
      ) : null}
    </>
  );
}

function Failed() {
  const p = usePalette();
  return (
    <View style={styles.failed}>
      <SymbolImage name="step.failed" size={12} color={p.danger} />
      <Text style={[styles.note, { color: p.danger }]}>failed</Text>
    </View>
  );
}

/** A row that opens: the line, what always shows under it (an image the
 *  step read), then (open) what's under it. */
function Row({
  line,
  open,
  onToggle,
  label,
  always,
  children,
}: {
  line: ReactNode;
  open: boolean;
  onToggle: () => void;
  label: string;
  always?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <View style={styles.rowWrap}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ expanded: open }}
        onPress={onToggle}
        hitSlop={4}
        className="rounded-lg active:opacity-60"
        style={styles.row}
      >
        {line}
      </Pressable>
      {always}
      {open ? children : null}
    </View>
  );
}

/** A step's text or output: long-press for Copy / Select text. */
function Detail({ label, text }: { label: string; text: string }) {
  const p = usePalette();
  return (
    <LongPressMenu text={text} kind="step">
      <View style={styles.detail}>
        <Text style={[styles.detailLabel, { color: p.muted }]}>{label}</Text>
        <Text
          selectable={selectable}
          style={[mono, styles.detailText, { color: p.text }]}
          numberOfLines={40}
        >
          {text}
        </Text>
      </View>
    </LongPressMenu>
  );
}

const ToolRow = memo(function ToolRow({
  step,
  running,
  keptAs,
}: {
  step: ToolStep;
  running: boolean;
  keptAs: string | null;
}) {
  const p = usePalette();
  const view = toolView(step, running);
  const [open, setOpen] = useKeptOpen(
    keptAs && `tool:${keptAs}:${step.id ?? ''}`,
  );
  const waiting = !!step.background && !step.summary;
  const busy = running && (step.ok == null || waiting);
  // An image the agent read: drawn under the row as soon as the step shows.
  const image = imageReadOf(step);
  return (
    <Row
      label={`${view.label}${view.chip ? ` ${view.chip}` : ''}`}
      open={open}
      onToggle={() => setOpen(!open)}
      always={image ? <StepThumbnail path={image} /> : null}
      line={
        <>
          <Icon busy={busy} name={KIND_ICON[view.kind]} />
          <Text numberOfLines={1} style={[styles.label, { color: p.muted }]}>
            {view.label}
          </Text>
          {view.chip ? <Chip text={view.chip} /> : null}
          {view.note ? (
            <Text style={[styles.note, { color: p.muted }]}>{view.note}</Text>
          ) : null}
          <Counts added={view.added} removed={view.removed} />
          {stepFailed(step) ? <Failed /> : null}
          <Chevron open={open} />
        </>
      }
    >
      <View style={[styles.under, { borderLeftColor: p.border }]}>
        {step.target ? <Detail label={step.name} text={step.target} /> : null}
        {step.detail && step.detail !== view.label ? (
          <Detail label="About" text={step.detail} />
        ) : null}
        {step.summary ? <Detail label="Result" text={step.summary} /> : null}
        {!step.target && !step.detail && !step.summary ? (
          <Text style={[styles.note, { color: p.muted }]}>
            {step.ok == null
              ? running
                ? 'Still running'
                : 'No result came'
              : 'Nothing more to show'}
          </Text>
        ) : null}
      </View>
    </Row>
  );
});

/** Consecutive calls of one read-only tool or one MCP server. */
function GroupRow({
  steps,
  keptAs,
}: {
  steps: ToolStep[];
  keptAs: string | null;
}) {
  const p = usePalette();
  const [open, setOpen] = useKeptOpen(keptAs);
  const first = steps[0]!;
  const label = groupLabel(first, steps.length);
  return (
    <Row
      label={label}
      open={open}
      onToggle={() => setOpen(!open)}
      line={
        <>
          <Icon busy={false} name={KIND_ICON[toolView(first).kind]} />
          <Text numberOfLines={1} style={[styles.label, { color: p.muted }]}>
            {label}
          </Text>
          <Chevron open={open} />
        </>
      }
    >
      <View style={styles.nested}>
        {steps.map((s, i) => (
          <ToolRow
            key={i}
            step={s}
            running={false}
            keptAs={keptAs && `${keptAs}:${i}`}
          />
        ))}
      </View>
    </Row>
  );
}

function ThinkingRow({
  text,
  busy,
  keptAs,
}: {
  text: string;
  busy: boolean;
  keptAs: string | null;
}) {
  const p = usePalette();
  const [open, setOpen] = useKeptOpen(keptAs && `thinking:${keptAs}`);
  return (
    <Row
      label="Thinking"
      open={open}
      onToggle={() => setOpen(!open)}
      line={
        <>
          <Icon busy={false} name="step.thinking" />
          {busy ? (
            <Shimmer>Thinking</Shimmer>
          ) : (
            <Text style={[styles.label, styles.fixed, { color: p.muted }]}>
              Thinking
            </Text>
          )}
          {open ? (
            <Chevron open />
          ) : (
            <Text
              numberOfLines={1}
              style={[
                styles.chip,
                { backgroundColor: p.surfaceMuted, color: p.muted },
              ]}
            >
              {text.replace(/\s+/g, ' ')}
            </Text>
          )}
        </>
      }
    >
      <View style={[styles.under, { borderLeftColor: p.border }]}>
        <ChatMarkdown size={13} muted>
          {text}
        </ChatMarkdown>
      </View>
    </Row>
  );
}

/** What a running subagent is on, in a few words. */
function latestOf(steps: readonly TurnStep[]): string | null {
  const last = steps.at(-1);
  if (!last) return null;
  if (last.kind === 'tool') {
    const view = toolView(last, true);
    return view.chip ? `${view.label} ${view.chip}` : view.label;
  }
  return last.kind === 'thinking' ? 'Thinking' : last.text.replace(/\s+/g, ' ');
}

function AgentRow({
  step,
  own,
  running,
  keptAs,
}: {
  step: ToolStep;
  own: readonly TurnStep[];
  running: boolean;
  keptAs: string | null;
}) {
  const p = usePalette();
  const [open, setOpen] = useKeptOpen(
    keptAs && `agent:${keptAs}:${step.id ?? ''}`,
  );
  const waiting = !!step.background && !step.summary;
  const busy = running && (step.ok == null || waiting);
  const view = toolView(step, running);
  // Its last message is the report shown above: not twice.
  const shown = useMemo(
    () => (step.summary ? withoutReportStep(own, step.summary) : own),
    [own, step.summary],
  );
  const beside = busy
    ? (latestOf(own) ?? (waiting ? 'running in background' : null))
    : (step.summary ?? (step.background ? 'ran in background' : null));
  return (
    <Row
      label={view.label}
      open={open}
      onToggle={() => setOpen(!open)}
      line={
        <>
          <Icon busy={busy} name={KIND_ICON.agent} />
          <Text numberOfLines={1} style={[styles.label, { color: p.muted }]}>
            {view.label}
          </Text>
          <Chevron open={open} />
          {beside && !open ? (
            <Text
              numberOfLines={1}
              style={[styles.note, styles.shrink, { color: p.muted }]}
            >
              {beside}
            </Text>
          ) : null}
          {stepFailed(step) ? <Failed /> : null}
        </>
      }
    >
      <View style={[styles.under, { borderLeftColor: p.border }]}>
        {step.summary ? (
          <ChatMarkdown size={13}>{step.summary}</ChatMarkdown>
        ) : null}
        <StepList
          own={shown}
          under={NOTHING_UNDER}
          options={busy ? { running: true } : { flat: true }}
          keptAs={keptAs && `${keptAs}:a`}
          running={busy}
        />
      </View>
    </Row>
  );
}

function FoldRow({
  item,
  under,
  keptAs,
}: {
  item: Extract<TurnItem, { kind: 'fold' }>;
  under: ReadonlyMap<string, TurnStep[]>;
  keptAs: string | null;
}) {
  const p = usePalette();
  const [open, setOpen] = useKeptOpen(keptAs && `fold:${keptAs}:${item.index}`);
  const line = foldLine(item.counts);
  return (
    <Row
      label={line}
      open={open}
      onToggle={() => setOpen(!open)}
      line={
        <>
          <Chevron open={open} />
          <Text numberOfLines={1} style={[styles.label, { color: p.muted }]}>
            {line}
          </Text>
          {item.icons.map((kind) => (
            <SymbolImage
              key={kind}
              name={KIND_ICON[kind]}
              size={12}
              color={p.muted}
            />
          ))}
        </>
      }
    >
      {/* A turn can hold hundreds of rows: none of them while folded. */}
      <View style={styles.nested}>
        <Items
          items={item.items}
          under={under}
          keptAs={keptAs}
          running={false}
          newest={-1}
        />
      </View>
    </Row>
  );
}

function Items({
  items,
  under,
  keptAs,
  running,
  newest,
}: {
  items: readonly TurnItem[];
  under: ReadonlyMap<string, TurnStep[]>;
  keptAs: string | null;
  running: boolean;
  newest: number;
}) {
  return (
    <>
      {items.map((item) => {
        if (item.kind === 'fold') {
          return (
            <FoldRow
              key={`f${item.index}`}
              item={item}
              under={under}
              keptAs={keptAs}
            />
          );
        }
        if (item.kind === 'group') {
          return (
            <GroupRow
              key={`g${item.index}`}
              steps={item.steps}
              keptAs={keptAs && `group:${keptAs}:${item.index}`}
            />
          );
        }
        const { step, index } = item;
        const kept = keptAs && `${keptAs}:${index}`;
        if (step.kind === 'text') {
          // The words being written now: plain, with a cursor, until the
          // step is done (markdown half-written reflows as it grows).
          return running && index === newest ? (
            <StreamingMessage key={index} text={step.text} />
          ) : (
            <ChatMarkdown key={index}>{step.text}</ChatMarkdown>
          );
        }
        if (step.kind === 'thinking') {
          return (
            <ThinkingRow
              key={index}
              text={step.text}
              busy={running && index === newest}
              keptAs={kept}
            />
          );
        }
        if (toolRow(step.name).kind === 'agent') {
          return (
            <AgentRow
              key={index}
              step={step}
              own={(step.id && under.get(step.id)) || NO_STEPS}
              running={running}
              keptAs={kept}
            />
          );
        }
        return (
          <ToolRow key={index} step={step} running={running} keptAs={kept} />
        );
      })}
    </>
  );
}

function StepList({
  own,
  under,
  options,
  keptAs,
  running,
}: {
  own: readonly TurnStep[];
  under: ReadonlyMap<string, TurnStep[]>;
  options: FoldOptions;
  keptAs: string | null;
  running: boolean;
}) {
  const { running: live, flat, pinLastText, keepText } = options;
  const items = useMemo(
    () => turnItems(own, { running: live, flat, pinLastText, keepText }),
    [own, live, flat, pinLastText, keepText],
  );
  return (
    <Items
      items={items}
      under={under}
      keptAs={keptAs}
      running={running}
      newest={own.length - 1}
    />
  );
}

/** The rows. `running`: a call with no result yet spins, nothing folds.
 *  `keptAs`: the reply's id, so what's open outlives a scroll. */
export const TimelineRows = memo(function TimelineRows({
  steps,
  running = false,
  keptAs = null,
  pinLastText = false,
  keepText = false,
}: {
  steps: readonly TurnStep[];
  running?: boolean;
  keptAs?: string | null;
  pinLastText?: boolean;
  keepText?: boolean;
}) {
  const { own, under } = useMemo(() => splitSteps(steps), [steps]);
  return (
    <View style={styles.timeline}>
      <StepList
        own={own}
        under={under}
        options={{ running, pinLastText, keepText }}
        keptAs={keptAs}
        running={running}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  timeline: { gap: 6, minWidth: 0 },
  rowWrap: { gap: 4, minWidth: 0 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 26,
    minWidth: 0,
  },
  icon: { width: 18, alignItems: 'center', justifyContent: 'center' },
  label: { fontSize: 13, flexShrink: 1 },
  failed: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  fixed: { flexShrink: 0 },
  shrink: { flexShrink: 1 },
  chip: {
    fontSize: 11,
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 1,
    overflow: 'hidden',
    flexShrink: 1,
  },
  note: { fontSize: 12 },
  count: { fontSize: 11 },
  under: {
    borderLeftWidth: StyleSheet.hairlineWidth * 2,
    paddingLeft: 12,
    marginLeft: 8,
    paddingVertical: 2,
    gap: 6,
  },
  nested: { gap: 8, paddingLeft: 18 },
  detail: { gap: 2 },
  detailLabel: { fontSize: 11, fontWeight: '600' },
  detailText: { fontSize: 12, lineHeight: 17 },
});
