import { stripHtmlComments } from '../highlight';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowUp,
  Check,
  ChevronDown,
  CircleCheck,
  CircleStop,
  CodeCommit,
  Comment as CommentIcon,
  Comments as CommentsIcon,
  Copy,
  FileCode,
  Layers,
  ListCheck,
  Plus,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
} from '@gravity-ui/icons';
import {
  Alert,
  AvatarGroup,
  Button,
  Card,
  Chip,
  Disclosure,
  Dropdown,
  EmptyState,
  Header,
  InputGroup,
  Label,
  ListBox,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from '@heroui/react';
import { observer } from 'mobx-react-lite';
import type {
  AgentId,
  Anchor,
  ChatMessage,
  Draft,
  Finding,
  PrId,
  SkillInfo,
  Thread,
} from '../gen/contract';
import { api } from '../core/api';
import {
  ask,
  cancelRun,
  commitSuggestions,
  findingToDraft,
  findingToTask,
  ignoreFinding,
  replyThread,
  resolveThread,
  runSkill,
} from '../actions';
import { useRootStore, useUi } from '../stores/context';
import { rich } from '../highlight';
import { useContextMenu, type ContextMenuItem } from './ContextMenu';
import { ago } from './List';
import { AgentTag, Avatar, Btn, Sev, Spinner } from './bits';
import { PatchView } from './Patch';
import { isAgentEnabled } from './Settings';
import { SkillBrowser } from './Skills';
import { TaskRow } from './Tasks';
import { SendToAgent } from './space/SendToAgent';

export type SideTab = 'ai' | 'tasks' | 'threads';

const AGENTS: AgentId[] = ['claude', 'codex', 'gemini'];

const plural = (n: number, one: string, few: string, many: string) =>
  `${n} ${n === 1 ? one : n >= 2 && n <= 4 ? few : many}`;

/** A small accent/warning chip for a tab's count, hidden at zero. */
function CountChip({
  n,
  color = 'accent',
}: {
  n: number;
  color?: 'accent' | 'warning';
}) {
  if (n <= 0) return null;
  return (
    <Chip size="sm" variant="soft" color={color} className="ml-1">
      {n}
    </Chip>
  );
}

export const SidePanel = observer(function SidePanel({ pr }: { pr: PrId }) {
  const [tab, setTab] = useState<SideTab>('ai');
  const store = useRootStore();
  const open = store.models.findings
    .byPr(pr)
    .filter((f) => f.state === 'open' || f.state === 'maybe_fixed').length;
  const threads = store.models.prDetails.get(pr)?.threads ?? [];
  const unresolved = threads.filter((t) => !t.resolved).length;
  const tasksOpen = store.models.tasks
    .byPr(pr)
    .filter((t) => t.status !== 'done').length;
  return (
    <div className="side flex min-h-0 flex-col border-l border-separator">
      <Tabs
        data-plain
        selectedKey={tab}
        onSelectionChange={(k) => setTab(k as SideTab)}
        className="side-tabs flex min-h-0 flex-1 flex-col [&>[role=tabpanel]]:border-t [&>[role=tabpanel]]:border-separator"
      >
        <Tabs.ListContainer className="mx-4 my-3">
          <Tabs.List aria-label="Review panel" className="w-full">
            <Tabs.Tab id="ai" className="gap-1.5">
              <Sparkles className="size-4" />
              AI
              <CountChip n={open} />
              <Tabs.Indicator />
            </Tabs.Tab>
            <Tabs.Tab id="tasks">
              Tasks
              <CountChip n={tasksOpen} />
              <Tabs.Indicator />
            </Tabs.Tab>
            <Tabs.Tab id="threads">
              Threads
              <CountChip n={unresolved} color="warning" />
              <Tabs.Indicator />
            </Tabs.Tab>
          </Tabs.List>
        </Tabs.ListContainer>
        <Tabs.Panel id="ai" className="flex min-h-0 flex-1 flex-col p-0">
          <Chat pr={pr} />
        </Tabs.Panel>
        <Tabs.Panel id="tasks" className="flex min-h-0 flex-1 flex-col p-0">
          <PrTasks pr={pr} />
        </Tabs.Panel>
        <Tabs.Panel id="threads" className="flex min-h-0 flex-1 flex-col p-0">
          <Threads pr={pr} />
        </Tabs.Panel>
      </Tabs>
    </div>
  );
});

/** A finding's anchor as an informational file:line chip. Not clickable:
 *  nothing outside `Review`'s own local diff state can jump the diff pane
 *  to a line yet, so this only orients, same as the prototype's `Ref` did,
 *  minus the jump. Capped to its container's width — a long path truncates
 *  inside the chip instead of forcing the panel wider. */
function Ref({ a }: { a: Anchor }) {
  return (
    <span
      className="ref inline-flex h-6 max-w-full items-center gap-1.5 rounded-full border border-separator px-2.5 font-mono text-xs text-muted"
      title={`${a.path}:${a.line}`}
    >
      <FileCode className="size-3.5 shrink-0" />
      {/* The file name, not the path: the chip shares a narrow row with the
       *  author; the full path is in the tooltip. */}
      <span className="min-w-0 truncate">
        {a.path.slice(a.path.lastIndexOf('/') + 1)}:{a.line}
      </span>
    </span>
  );
}

/** Typing indicator: three dots, like a messenger. */
function Dots() {
  return (
    <span
      className="inline-flex h-5 items-center gap-1"
      aria-label="Agent is thinking"
    >
      {[0, 150, 300].map((d) => (
        <span
          key={d}
          className="size-1.5 animate-bounce rounded-full bg-muted"
          style={{ animationDelay: `${d}ms` }}
        />
      ))}
    </span>
  );
}

/** Collapsible card with the log lines an agent produced for this answer.
 *  Open while the agent works, folds away once it's done — remounted (via
 *  `key`) rather than synced through an effect, so there's no setState in
 *  an effect body to cascade a render. */
export function ToolCalls({
  tools,
  running,
}: {
  tools: string[];
  running: boolean;
}) {
  return (
    <Disclosure
      key={running ? 'running' : 'done'}
      defaultExpanded={running}
      className="rounded-2xl border border-separator"
    >
      <Disclosure.Heading>
        <Disclosure.Trigger className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs">
          {running ? (
            <Spinner />
          ) : (
            <CircleCheck className="size-3.5 text-success" />
          )}
          <span className="text-muted">{running ? 'Working:' : 'Done:'}</span>
          <span className="truncate font-medium">
            {plural(tools.length, 'log line', 'log lines', 'log lines')}
          </span>
          <Disclosure.Indicator />
        </Disclosure.Trigger>
      </Disclosure.Heading>
      <Disclosure.Content>
        <Disclosure.Body className="runlog flex flex-col gap-1 px-3 pb-2.5 pt-0 font-mono text-xs text-muted">
          {tools.map((t, i) => (
            <span key={i}>{t}</span>
          ))}
        </Disclosure.Body>
      </Disclosure.Content>
    </Disclosure>
  );
}

function MessageActions({
  text,
  onRetry,
}: {
  text: string;
  onRetry?: () => void;
}) {
  const [vote, setVote] = useState<'up' | 'down' | null>(null);
  const [copied, setCopied] = useState(false);
  const act = (
    label: string,
    icon: ReactNode,
    onPress: () => void,
    on = false,
  ) => (
    <Tooltip key={label}>
      <Button
        isIconOnly
        size="sm"
        variant="ghost"
        aria-label={label}
        className={`size-7 min-w-7 ${on ? 'text-foreground' : 'text-muted'}`}
        onPress={onPress}
      >
        {icon}
      </Button>
      <Tooltip.Content>{label}</Tooltip.Content>
    </Tooltip>
  );
  return (
    <div className="-ms-1.5 flex items-center gap-0.5">
      {act(
        copied ? 'Copied' : 'Copy',
        copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />,
        () => {
          void navigator.clipboard?.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        },
      )}
      {act(
        'Helpful',
        <ThumbsUp className="size-3.5" />,
        () => setVote(vote === 'up' ? null : 'up'),
        vote === 'up',
      )}
      {act(
        'Not helpful',
        <ThumbsDown className="size-3.5" />,
        () => setVote(vote === 'down' ? null : 'down'),
        vote === 'down',
      )}
      {onRetry && (
        <Btn tone="ghost" className="ms-1 h-7 px-2 text-xs" onPress={onRetry}>
          Ask again
        </Btn>
      )}
    </div>
  );
}

const RANK = { high: 0, warn: 1, info: 2 } as const;

/** A skill run inside the chat: the live log, then its findings — with a
 *  severity filter and bulk actions so a long list turns into tasks or
 *  review comments in one go. */
const SkillRunView = observer(function SkillRunView({
  pr,
  run,
}: {
  pr: PrId;
  run: string;
}) {
  const store = useRootStore();
  const r = store.models.skillRuns.get(run);
  const log = store.ephemeral.runLog.get(run) ?? [];
  const liveText = store.ephemeral.agentText.get(run);
  const [sev, setSev] = useState<Finding['severity'] | 'all'>('all');
  const all = store.models.findings
    .byPr(pr)
    .filter((f) => f.skill === r?.skill && f.state !== 'ignored')
    .sort((a, b) => RANK[a.severity] - RANK[b.severity]);
  const openFindings = all.filter(
    (f) => f.state === 'open' || f.state === 'maybe_fixed',
  );
  const shown = all.filter((f) => sev === 'all' || f.severity === sev);
  const count = (s: Finding['severity']) =>
    all.filter((f) => f.severity === s).length;
  if (!r) return null;
  const done = r.status === 'done';
  const live = r.status === 'running';
  const other = AGENTS.find((a) => !r.agents.includes(a));
  return (
    <div className="skill flex flex-col gap-2.5">
      <div className="flex items-center gap-2 text-sm">
        <span className="min-w-0 flex-1">
          {r.status === 'cancelled' ? (
            <>
              <span className="font-mono">/{r.skill}</span> stopped
            </>
          ) : r.status === 'failed' || r.status === 'stalled' ? (
            <>
              <span className="font-mono">/{r.skill}</span>{' '}
              {r.status === 'failed' ? 'failed' : 'stalled'}
            </>
          ) : done ? (
            <>
              <span className="font-mono">/{r.skill}</span>:{' '}
              {all.length
                ? plural(all.length, 'finding', 'findings', 'findings')
                : 'nothing found'}
            </>
          ) : (
            <span className="inline-flex items-center gap-2">
              <Sparkles className="size-4 shrink-0 animate-pulse text-accent" />
              <span className="shimmer-text">
                Running /{r.skill} on {r.agents.join(' + ')}
              </span>
            </span>
          )}
        </span>
        {(live || r.status === 'stalled') && (
          <Button
            size="sm"
            variant="ghost"
            className="cancel-run h-7 px-2 text-xs"
            onPress={() => void cancelRun(store, run)}
          >
            <CircleStop className="size-3.5" />
            Stop
          </Button>
        )}
      </div>
      {live && liveText && (
        <div className="rich whitespace-pre-wrap text-sm leading-relaxed">
          {rich(liveText)}
        </div>
      )}
      {(r.status === 'failed' || r.status === 'stalled') && (
        <div className="run-error rounded-2xl border border-danger/40 bg-danger-soft px-3 py-2 text-xs text-danger">
          {r.error}
          <div className="mt-2 flex gap-1.5">
            <Button
              size="sm"
              variant="tertiary"
              onPress={() => void runSkill(store, pr, r.skill, r.agents)}
            >
              Restart
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onPress={() =>
                void store.sync.queue.transact([
                  { op: 'archive', model: 'skill_run', id: r.id },
                ])
              }
            >
              Dismiss
            </Button>
            {other && (
              <Button
                size="sm"
                variant="ghost"
                onPress={() => void runSkill(store, pr, r.skill, [other])}
              >
                Only {other}
              </Button>
            )}
          </div>
        </div>
      )}
      {log.length > 0 && <ToolCalls tools={log} running={live} />}
      {done && all.length > 0 && (
        <div
          role="toolbar"
          aria-label="Findings"
          className="flex flex-wrap items-center gap-1.5"
        >
          {(['all', 'high', 'warn', 'info'] as const)
            .filter((x) => x === 'all' || count(x))
            .map((x) => (
              <Btn
                key={x}
                tone={sev === x ? 'secondary' : 'tertiary'}
                onPress={() => setSev(x)}
              >
                {x === 'all' ? `All ${all.length}` : `${x} ${count(x)}`}
              </Btn>
            ))}
          {openFindings.length > 0 && (
            <>
              <Btn
                icon={<ListCheck />}
                onPress={() =>
                  openFindings.forEach((f) => findingToTask(store, pr, f))
                }
              >
                Add all to tasks
              </Btn>
              <Btn
                icon={<Plus />}
                onPress={() =>
                  openFindings.forEach((f) => findingToDraft(store, pr, f))
                }
              >
                Add all to review
              </Btn>
            </>
          )}
        </div>
      )}
      {shown.map((f) => (
        <FindingCard key={f.id} pr={pr} f={f} />
      ))}
    </div>
  );
});

const FindingCard = observer(function FindingCard({
  pr,
  f,
}: {
  pr: PrId;
  f: Finding;
}) {
  const store = useRootStore();
  const findingMenu = useContextMenu((): ContextMenuItem[] => [
    {
      id: 'add-review',
      label: 'Add to review',
      isDisabled: f.state === 'drafted',
      onAction: () => findingToDraft(store, pr, f),
    },
    {
      id: 'add-tasks',
      label: 'Add to tasks',
      isDisabled: f.state === 'drafted',
      onAction: () => findingToTask(store, pr, f),
    },
    {
      id: 'propose-fix',
      label: 'Propose fix',
      isDisabled: f.fix?.status === 'generating',
      onAction: () =>
        void ask(store, {
          pr,
          question: `propose a fix for: ${f.title}`,
          about: f.anchor,
          group: null,
          agent: null,
        }).catch(() => {
          // toasted by api.ts
        }),
    },
    {
      id: 'ignore',
      label: 'Ignore',
      isDisabled: f.state === 'drafted',
      onAction: () => ignoreFinding(store, f.id),
    },
  ]);
  return (
    <Card
      className={`finding mt-1 gap-2 px-4 py-3 ${f.state === 'drafted' ? 'opacity-60' : ''}`}
      onContextMenu={findingMenu}
    >
      <div className="flex items-center gap-1.5">
        <Sev s={f.severity} />
        <b>{f.title}</b>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <Ref a={f.anchor} />
        {f.agents.map((a) => (
          <AgentTag key={a} id={a} />
        ))}
        {f.agents.length > 1 && (
          <span className="text-xs text-muted">
            {f.agents.length === 2 ? 'both found it' : 'all found it'}
          </span>
        )}
      </div>
      <div className="rich text-sm text-muted">{rich(f.body)}</div>
      {f.state === 'maybe_fixed' && (
        <div className="text-xs text-success">
          May already be fixed by a later commit — recheck
        </div>
      )}
      {f.fix?.status === 'generating' && (
        <div className="flex items-center gap-2 text-xs text-muted">
          <Spinner /> {f.agents[0]} is preparing a patch…
        </div>
      )}
      {f.fix?.patch && f.fix.status !== 'generating' && (
        <>
          <PatchView
            patch={f.fix.patch}
            status={
              f.fix.status === 'applied'
                ? 'applied'
                : f.fix.status === 'suggested'
                  ? 'in review as a suggestion'
                  : f.fix.status === 'rejected'
                    ? 'rejected'
                    : undefined
            }
          />
          {f.fix.status === 'ready' && (
            <div className="fix-actions flex flex-wrap gap-1">
              <Tooltip>
                <Btn tone="success" icon={<Check />} isDisabled>
                  Apply
                </Btn>
                <Tooltip.Content>Not available yet</Tooltip.Content>
              </Tooltip>
              <Tooltip>
                <Btn tone="ghost" isDisabled>
                  Reject
                </Btn>
                <Tooltip.Content>Not available yet</Tooltip.Content>
              </Tooltip>
            </div>
          )}
        </>
      )}
      <div className="flex flex-wrap gap-1">
        {f.state === 'drafted' ? (
          <span className="text-xs text-muted">Already in review or tasks</span>
        ) : (
          <>
            <Btn
              icon={<ListCheck />}
              onPress={() => findingToDraft(store, pr, f)}
            >
              Add to review
            </Btn>
            <Btn
              tone="secondary"
              icon={<Plus />}
              onPress={() => findingToTask(store, pr, f)}
            >
              Add to tasks
            </Btn>
            <Btn
              tone="ghost"
              icon={<Sparkles />}
              onPress={() =>
                void ask(store, {
                  pr,
                  question: `${f.title}: is this right?`,
                  about: f.anchor,
                  group: null,
                  agent: null,
                }).catch(() => {})
              }
            >
              Discuss
            </Btn>
            <Btn tone="tertiary" onPress={() => ignoreFinding(store, f.id)}>
              Ignore
            </Btn>
            <SendToAgent pr={pr} item={{ kind: 'finding', id: f.id }} />
          </>
        )}
      </div>
    </Card>
  );
});

/** Skills matching what's typed after `/`, nothing once a space ends the name. */
function matchSkills(skills: SkillInfo[], text: string): SkillInfo[] | null {
  if (!text.startsWith('/') || /\s/.test(text)) return null;
  const q = text.slice(1).toLowerCase();
  return skills.filter((s) => s.id.toLowerCase().includes(q));
}

/** Finds the user's question right before an agent's reply, for "Ask again". */
export function priorQuestion(
  messages: ChatMessage[],
  reply: ChatMessage,
): string {
  const i = messages.findIndex((m) => m.id === reply.id);
  for (let j = i - 1; j >= 0; j--) {
    const m = messages[j]!;
    if (m.author.kind === 'me') return m.text;
  }
  return '';
}

/** An agent run that errored, crashed, hit its runtime cap, or was
 *  cancelled (`ChatMessage.failed` set): an inline "stopped" card instead
 *  of a normal reply, with Retry re-sending the question that led to it. */
const AgentFailedCard = observer(function AgentFailedCard({
  pr,
  m,
  messages,
}: {
  pr: PrId;
  m: ChatMessage;
  messages: ChatMessage[];
}) {
  const store = useRootStore();
  const question = priorQuestion(messages, m);
  return (
    <Alert status="danger" className="agent-failed">
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Description className="text-xs">{m.failed}</Alert.Description>
        {question && (
          <div className="mt-2 flex gap-1.5">
            <Button
              size="sm"
              variant="tertiary"
              onPress={() => {
                void ask(store, {
                  pr,
                  question,
                  about: null,
                  group: null,
                  agent: m.author.kind === 'me' ? null : m.author.agent,
                }).catch(() => {});
              }}
            >
              Retry
            </Button>
          </div>
        )}
      </Alert.Content>
    </Alert>
  );
});

const Chat = observer(function Chat({ pr }: { pr: PrId }) {
  const store = useRootStore();
  const [text, setText] = useState('');
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [skillAgents, setSkillAgents] = useState<AgentId[]>(AGENTS);
  const [installed, setInstalled] = useState<AgentId[] | null>(null);
  // Default to the agents actually installed on this machine, minus any the
  // user has disabled (plan "enable/disable agents": hidden from the chat
  // picker, skipped for skills).
  useEffect(() => {
    let live = true;
    void api
      .detectAgents()
      .then((all) => {
        const ids = all
          .filter((a) => a.installed && isAgentEnabled(store, a.id))
          .map((a) => a.id);
        if (!live) return;
        setInstalled(ids);
        if (ids.length > 0) setSkillAgents(ids);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [store]);
  const [hi, setHi] = useState(0);
  const [pending, setPending] = useState<{
    run: string;
    startedAt: number;
    /** So a stalled run's Retry can resend the same question. */
    question: string;
    agent: AgentId | null;
  } | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const messages = [...store.models.chatMessages.byPr(pr)].sort(
    (a, b) => a.at - b.at,
  );
  const runs = store.models.skillRuns.byPr(pr);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, runs.length, pending]);
  useEffect(() => {
    void api
      .listSkills(pr)
      .then(setSkills)
      .catch(() => setSkills([]));
  }, [pr]);
  // Once an agent message lands after we fired the ask, the pending bubble
  // has nothing left to show — the real message takes over.
  useEffect(() => {
    if (
      pending &&
      messages.some((m) => m.author.kind !== 'me' && m.at >= pending.startedAt)
    ) {
      setPending(null);
    }
  }, [messages, pending]);

  const matches = matchSkills(skills, text);
  useEffect(() => setHi(0), [text]);

  const runMatch = (s: SkillInfo) => {
    void runSkill(store, pr, s.id, skillAgents);
    setText('');
  };

  const send = () => {
    const t = text.trim();
    if (!t) return;
    if (matches && matches[hi]) {
      runMatch(matches[hi]!);
      return;
    }
    if (t.startsWith('/')) {
      void runSkill(store, pr, t.slice(1).split(' ')[0] ?? '', skillAgents);
    } else {
      const startedAt = Date.now();
      const agent = skillAgents[0] ?? null;
      void ask(store, {
        pr,
        question: t,
        about: null,
        group: null,
        agent,
      })
        .then((run) => setPending({ run, startedAt, question: t, agent }))
        .catch(() => {});
    }
    setText('');
  };

  return (
    <div className="chat flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto px-4 py-5">
        {messages.length === 0 && runs.length === 0 && !pending ? (
          <div className="m-auto flex w-full flex-col gap-4">
            <div className="flex flex-col items-center gap-2 text-center">
              <span className="grid size-10 place-items-center rounded-full bg-default text-muted">
                <Sparkles className="size-5" />
              </span>
              <Typography.Heading level={6}>
                Ask about this PR
              </Typography.Heading>
              <Typography.Paragraph size="sm" color="muted" align="center">
                The agent works in a worktree and sees the whole repo.
              </Typography.Paragraph>
            </div>
            {skills.length > 0 && (
              <ListBox
                aria-label="Suggested skills"
                selectionMode="none"
                onAction={(k) => {
                  const s = skills.find((x) => x.id === String(k));
                  if (s) runMatch(s);
                }}
                className="flex w-full flex-col gap-1.5 p-0"
              >
                {skills.slice(0, 3).map((k) => (
                  <ListBox.Item
                    key={k.id}
                    id={k.id}
                    textValue={k.title}
                    className="w-full gap-2.5 rounded-2xl border border-separator bg-surface px-3 py-2.5 text-sm"
                  >
                    <span className="grid size-4 shrink-0 place-items-center font-mono text-muted">
                      /
                    </span>
                    <span className="shrink-0 font-mono">{k.id}</span>
                    <span
                      className="min-w-0 flex-1 truncate text-xs text-muted"
                      title={k.description}
                    >
                      {k.description}
                    </span>
                  </ListBox.Item>
                ))}
              </ListBox>
            )}
          </div>
        ) : (
          <>
            {runs.map((r) => (
              <SkillRunView key={r.id} pr={pr} run={r.id} />
            ))}
            {messages.map((m) =>
              m.author.kind === 'me' ? (
                <div key={m.id} className="msg user flex justify-end">
                  <div className="rich max-w-[85%] whitespace-pre-wrap rounded-3xl bg-default px-4 py-2 text-sm">
                    {rich(m.text)}
                  </div>
                </div>
              ) : (
                <div key={m.id} className="msg agent flex gap-3">
                  <div className="flex min-w-0 flex-1 flex-col gap-2 pt-1">
                    <AgentTag id={m.author.agent} />
                    {m.failed ? (
                      <AgentFailedCard pr={pr} m={m} messages={messages} />
                    ) : (
                      <>
                        <div className="rich whitespace-pre-wrap text-sm leading-relaxed">
                          {rich(m.text)}
                        </div>
                        {m.refs.length > 0 && (
                          <div className="flex flex-wrap gap-1.5">
                            {m.refs.map((a, i) => (
                              <Ref key={i} a={a} />
                            ))}
                          </div>
                        )}
                        <MessageActions
                          text={m.text}
                          onRetry={() => {
                            const q = priorQuestion(messages, m);
                            const agent =
                              m.author.kind === 'me' ? null : m.author.agent;
                            if (q)
                              void ask(store, {
                                pr,
                                question: q,
                                about: null,
                                group: null,
                                agent,
                              }).catch(() => {});
                          }}
                        />
                      </>
                    )}
                  </div>
                </div>
              ),
            )}
            {pending &&
              (() => {
                const stalled = store.ephemeral.stalled.has(pending.run);
                const stop = () => {
                  void cancelRun(store, pending.run);
                  setPending(null);
                };
                return (
                  <div className="msg agent flex gap-3">
                    <div className="flex min-w-0 flex-1 flex-col gap-2 pt-1">
                      {stalled ? (
                        <Alert status="warning" className="agent-stalled">
                          <Alert.Indicator />
                          <Alert.Content>
                            <Alert.Description className="text-xs">
                              No response in a while — the agent may be stuck.
                            </Alert.Description>
                          </Alert.Content>
                        </Alert>
                      ) : store.ephemeral.agentText.get(pending.run) ? (
                        <div className="rich whitespace-pre-wrap text-sm leading-relaxed">
                          {rich(store.ephemeral.agentText.get(pending.run)!)}
                        </div>
                      ) : (
                        <Dots />
                      )}
                      {(store.ephemeral.runLog.get(pending.run)?.length ?? 0) >
                        0 && (
                        <ToolCalls
                          tools={store.ephemeral.runLog.get(pending.run)!}
                          running
                        />
                      )}
                      <div className="flex gap-1.5">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 w-fit px-2 text-xs"
                          onPress={stop}
                        >
                          <CircleStop className="size-3.5" />
                          Stop
                        </Button>
                        {stalled && (
                          <Button
                            size="sm"
                            variant="tertiary"
                            className="h-7 w-fit px-2 text-xs"
                            onPress={() => {
                              const { question, agent } = pending;
                              stop();
                              const startedAt = Date.now();
                              void ask(store, {
                                pr,
                                question,
                                about: null,
                                group: null,
                                agent,
                              })
                                .then((run) =>
                                  setPending({
                                    run,
                                    startedAt,
                                    question,
                                    agent,
                                  }),
                                )
                                .catch(() => {});
                            }}
                          >
                            Retry
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })()}
          </>
        )}
        <div ref={end} />
      </div>

      <div className="chat-input flex flex-col gap-2.5 border-t border-separator px-4 pb-3 pt-3">
        {matches && matches.length > 0 && (
          <Card className="slash-menu min-w-0 gap-0 p-1.5 shadow-overlay">
            <ListBox
              aria-label="Skills"
              selectionMode="none"
              onAction={(k) => {
                const s = matches.find((x) => x.id === String(k));
                if (s) runMatch(s);
              }}
              className="max-h-72 overflow-y-auto p-0"
            >
              {matches.map((s, i) => (
                <ListBox.Item
                  key={s.id}
                  id={s.id}
                  textValue={s.title}
                  onHoverStart={() => setHi(i)}
                  className={`min-w-0 flex-col items-start gap-0.5 rounded-2xl px-3 py-2 ${i === Math.min(hi, matches.length - 1) ? 'bg-default' : ''}`}
                >
                  <span className="flex w-full min-w-0 items-center gap-2">
                    <span className="truncate font-mono text-sm">/{s.id}</span>
                    <span className="ms-auto max-w-40 shrink-0 truncate text-xs text-muted">
                      {s.source}
                    </span>
                  </span>
                  <span
                    className="line-clamp-2 w-full text-xs text-muted"
                    title={s.description}
                  >
                    {s.description}
                  </span>
                </ListBox.Item>
              ))}
            </ListBox>
            <div className="flex items-center gap-1 px-3 pb-1 pt-1.5 text-xs text-muted">
              Runs on {skillAgents.join(' + ')}
            </div>
          </Card>
        )}
        <TextField
          fullWidth
          aria-label="Ask the agent"
          value={text}
          onChange={setText}
        >
          <InputGroup
            fullWidth
            className="flex flex-col gap-2 rounded-3xl py-2.5"
          >
            <InputGroup.TextArea
              rows={2}
              className="w-full resize-none px-4 py-0"
              placeholder="Ask about the code, or / to run a skill"
              onKeyDown={(e) => {
                if (matches && matches.length > 0) {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setHi((n) => Math.min(matches.length - 1, n + 1));
                    return;
                  }
                  if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setHi((n) => Math.max(0, n - 1));
                    return;
                  }
                  if (e.key === 'Tab' || e.key === 'Enter') {
                    e.preventDefault();
                    runMatch(matches[Math.min(hi, matches.length - 1)]!);
                    return;
                  }
                }
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <InputGroup.Suffix className="flex w-full items-center gap-1.5 px-2.5 py-0">
              <Tooltip>
                <Button
                  isIconOnly
                  size="sm"
                  variant="tertiary"
                  aria-label="Skills"
                  className="slash-btn shrink-0 rounded-full font-mono"
                  onPress={() => setText('/')}
                >
                  /
                </Button>
                <Tooltip.Content>Run a skill</Tooltip.Content>
              </Tooltip>
              <span className="shrink-0">
                <SkillBrowser
                  pr={pr}
                  skills={skills}
                  agents={skillAgents}
                  onRun={(s, agents) => {
                    void runSkill(store, pr, s.id, agents);
                  }}
                />
              </span>
              <Dropdown>
                <Button
                  size="sm"
                  variant="tertiary"
                  className="min-w-0 shrink gap-1.5 rounded-full px-3 text-xs"
                >
                  <span className="min-w-0 truncate">
                    {skillAgents.join(' + ')}
                  </span>
                  <ChevronDown className="size-3 shrink-0 text-muted" />
                </Button>
                <Dropdown.Popover placement="top start">
                  <Dropdown.Menu
                    aria-label="Agents"
                    selectionMode="multiple"
                    selectedKeys={new Set(skillAgents)}
                    onSelectionChange={(keys) => {
                      const next = AGENTS.filter(
                        (a) => keys === 'all' || keys.has(a),
                      );
                      if (next.length) setSkillAgents(next);
                    }}
                  >
                    {/* Only agents installed on this computer and not
                        disabled in Settings → Agents are offered. */}
                    {(installed ?? AGENTS)
                      .filter((a) => isAgentEnabled(store, a))
                      .map((a) => (
                        <Dropdown.Item key={a} id={a} textValue={a}>
                          <Label>{a}</Label>
                          <Dropdown.ItemIndicator />
                        </Dropdown.Item>
                      ))}
                  </Dropdown.Menu>
                </Dropdown.Popover>
              </Dropdown>
              <span className="flex-1" />
              <Button
                isIconOnly
                size="sm"
                aria-label="Send"
                className="shrink-0 rounded-full"
                isDisabled={!text.trim()}
                onPress={send}
              >
                <ArrowUp className="size-4" />
              </Button>
            </InputGroup.Suffix>
          </InputGroup>
        </TextField>
        <div className="flex items-center gap-2 text-xs text-muted">
          <span className="min-w-0 truncate">The agent can be wrong</span>
        </div>
      </div>
    </div>
  );
});

const PrTasks = observer(function PrTasks({ pr }: { pr: PrId }) {
  const store = useRootStore();
  const ui = useUi();
  const tasks = store.models.tasks.byPr(pr);
  return (
    <ListBox
      aria-label="PR tasks"
      selectionMode="single"
      selectedKeys={ui.selected ? [ui.selected] : []}
      onSelectionChange={(keys) => {
        const k = keys === 'all' ? null : [...keys][0];
        if (k != null) ui.select(String(k));
      }}
      renderEmptyState={() => (
        <EmptyState className="rounded-2xl border border-dashed border-separator p-4 text-sm">
          No tasks. Create one from a skill finding or a thread. Once the review
          is submitted, each comment also becomes a task for the author.
        </EmptyState>
      )}
      className="min-h-0 flex-1 overflow-auto p-4"
    >
      {tasks.map((t) => (
        <ListBox.Item
          key={t.id}
          id={t.id}
          textValue={t.title}
          className="mb-2 rounded-2xl border border-separator px-3"
        >
          <TaskRow t={t} compact sel={ui.selected === t.id} />
        </ListBox.Item>
      ))}
    </ListBox>
  );
});

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <Header className="px-1 pb-1 text-xs font-medium text-muted">
        {title}
      </Header>
      {children}
    </div>
  );
}

function DraftCard({ d }: { d: Draft }) {
  return (
    <Card className="titem flex flex-col gap-2 border border-dashed border-warning/50 px-4 py-3">
      <div className="flex items-center gap-2">
        <Chip size="sm" variant="soft" color="warning">
          pending
        </Chip>
        {d.source.kind === 'agent' && <AgentTag id={d.source.agent} />}
        <span className="flex-1" />
        <SendToAgent pr={d.pr} item={{ kind: 'draft', id: d.id }} />
        <Ref a={d.anchor} />
      </div>
      <p className="line-clamp-2 text-sm text-muted">
        {stripHtmlComments(d.body)}
      </p>
    </Card>
  );
}

function ThreadCardInner({ pr, thread }: { pr: PrId; thread: Thread }) {
  const store = useRootStore();
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const people = [
    ...new Map(thread.comments.map((c) => [c.author.login, c.author])),
  ];
  const last = thread.comments.at(-1)!;
  const send = () => {
    const body = reply.trim();
    if (!body) return;
    setBusy(true);
    void replyThread(store, pr, thread.id, body)
      .then(() => setReply(''))
      .finally(() => setBusy(false));
  };
  return (
    <Card
      className={`titem flex flex-col gap-2 border border-separator px-4 py-3 ${thread.resolved ? 'opacity-70' : ''}`}
    >
      <div className="flex items-center gap-2">
        {thread.resolved ? (
          <CircleCheck className="size-4 text-success" />
        ) : (
          <CommentIcon className="size-4 text-warning" />
        )}
        <AvatarGroup>
          {people.map(([login, person]) => (
            <Avatar key={login} person={person} size={20} />
          ))}
        </AvatarGroup>
        <span className="min-w-12 max-w-[50%] shrink-0 truncate text-sm font-medium">
          {people.map(([login]) => login).join(', ')}
        </span>
        <span className="flex-1" />
        {thread.anchor && (
          <span className="flex min-w-0 shrink justify-end">
            <Ref a={thread.anchor} />
          </span>
        )}
      </div>
      <p className="line-clamp-2 text-sm text-muted">
        {/* Name the speaker only when more than one person is in the thread;
         *  the header already shows a lone author. */}
        {people.length > 1 && (
          <>
            <span className="text-foreground">{last.author.login}:</span>{' '}
          </>
        )}
        {stripHtmlComments(last.body)}
      </p>
      <div className="flex items-center justify-between text-xs text-muted">
        <span>
          {plural(thread.comments.length, 'comment', 'comments', 'comments')} ·{' '}
          {ago(last.created_at)}
        </span>
        {thread.outdated && <span>outdated</span>}
      </div>
      {thread.resolved ? (
        <Btn
          tone="ghost"
          className="w-fit"
          onPress={() => void resolveThread(store, pr, thread.id, false)}
        >
          Reopen
        </Btn>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          <TextField
            aria-label="Reply"
            value={reply}
            onChange={setReply}
            className="min-w-0 flex-1 basis-40"
          >
            <InputGroup fullWidth className="rounded-2xl">
              <InputGroup.Input
                placeholder="Reply…"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
              />
            </InputGroup>
          </TextField>
          <Button
            isIconOnly
            size="sm"
            aria-label="Send reply"
            isPending={busy}
            isDisabled={!reply.trim()}
            onPress={send}
          >
            <ArrowUp className="size-4" />
          </Button>
          <SendToAgent pr={pr} item={{ kind: 'thread', id: thread.id }} />
          <Btn
            tone="tertiary"
            icon={<Check />}
            onPress={() => void resolveThread(store, pr, thread.id, true)}
          >
            Resolve
          </Btn>
        </div>
      )}
    </Card>
  );
}

/** Suggestions queued with "Add to batch" (`Comments.tsx`'s `CommentView`),
 *  committed together as one push — GitHub's batch-suggestion flow. */
const SuggestionBatchBar = observer(function SuggestionBatchBar({
  pr,
}: {
  pr: PrId;
}) {
  const store = useRootStore();
  const [busy, setBusy] = useState(false);
  const batch = [...store.ephemeral.batchOf(pr)];
  if (!batch.length) return null;
  return (
    <div className="batch-bar sticky bottom-0 z-[3] flex items-center gap-3 rounded-2xl border border-accent/40 bg-surface px-4 py-2 text-sm shadow-lg">
      <Layers className="size-4 text-accent" />
      <span className="min-w-0 flex-1">
        {plural(
          batch.length,
          'batched suggestion',
          'batched suggestions',
          'batched suggestions',
        )}{' '}
        — will go out as one commit
      </span>
      <Button
        size="sm"
        variant="ghost"
        onPress={() => store.ephemeral.clearBatch(pr)}
      >
        Clear
      </Button>
      <Btn
        tone="primary"
        icon={<CodeCommit />}
        className="commit-batch"
        isPending={busy}
        onPress={() => {
          setBusy(true);
          void commitSuggestions(store, pr, batch).finally(() =>
            setBusy(false),
          );
        }}
      >
        Commit batch
      </Btn>
    </div>
  );
});

/** All threads and pending drafts of this PR, grouped like an inbox. */
const Threads = observer(function Threads({ pr }: { pr: PrId }) {
  const store = useRootStore();
  const threads = store.models.prDetails.get(pr)?.threads ?? [];
  const drafts = store.models.drafts.byPr(pr);
  const open = threads.filter((t) => !t.resolved);
  const resolved = threads.filter((t) => t.resolved);

  if (!open.length && !drafts.length && !resolved.length) {
    return (
      <EmptyState className="flex flex-col items-center gap-2 p-8 text-center text-sm">
        <CommentsIcon className="size-6 text-muted" />
        No threads yet. Start one from a diff line.
      </EmptyState>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
      {open.length > 0 && (
        <Section title={`Open · ${open.length}`}>
          {open.map((t) => (
            <ThreadCard key={t.id} pr={pr} thread={t} />
          ))}
        </Section>
      )}
      {drafts.length > 0 && (
        <Section title={`Drafts · ${drafts.length}`}>
          {drafts.map((d) => (
            <DraftCard key={d.id} d={d} />
          ))}
        </Section>
      )}
      {resolved.length > 0 && (
        <Section title={`Resolved · ${resolved.length}`}>
          {resolved.map((t) => (
            <ThreadCard key={t.id} pr={pr} thread={t} />
          ))}
        </Section>
      )}
      <SuggestionBatchBar pr={pr} />
    </div>
  );
});

const ThreadCard = observer(ThreadCardInner);
