import { useEffect, useRef, useState } from 'react';
import {
  ArrowUp,
  Check,
  CircleStop,
  ListCheck,
  Sparkles,
} from '@gravity-ui/icons';
import {
  Button,
  Card,
  EmptyState,
  InputGroup,
  ListBox,
  Tabs,
  TextField,
  Typography,
} from '@heroui/react';
import { observer } from 'mobx-react-lite';
import type { Finding, PrId } from '../gen/contract';
import {
  ask,
  cancelRun,
  findingToDraft,
  ignoreFinding,
  resolveThread,
  runSkill,
} from '../actions';
import { useRootStore, useUi } from '../stores/context';
import { rich } from '../highlight';
import { AgentTag, Avatar, Btn, Sev } from './bits';
import { PatchView } from './Patch';
import { TaskRow } from './Tasks';

export type SideTab = 'ai' | 'tasks' | 'threads';

export const SidePanel = observer(function SidePanel({ pr }: { pr: PrId }) {
  const [tab, setTab] = useState<SideTab>('ai');
  const store = useRootStore();
  const open = store.models.findings.where(
    (f) => f.pr === pr && f.state === 'open',
  ).length;
  const unresolved = store.models.threads.where((t) => !t.resolved).length;
  const tasksOpen = store.models.tasks.where(
    (t) => t.pr === pr && t.status !== 'done',
  ).length;
  return (
    <div className="side flex min-h-0 flex-col border-l border-separator">
      <Tabs
        data-plain
        selectedKey={tab}
        onSelectionChange={(k) => setTab(k as SideTab)}
        className="side-tabs flex min-h-0 flex-1 flex-col"
      >
        <Tabs.ListContainer className="mx-4 my-3">
          <Tabs.List aria-label="Review panel" className="w-full">
            <Tabs.Tab id="ai" className="gap-1.5">
              <Sparkles className="size-4" />
              AI
              {open > 0 && <span className="ml-1 text-warning">{open}</span>}
              <Tabs.Indicator />
            </Tabs.Tab>
            <Tabs.Tab id="tasks">
              Tasks
              {tasksOpen > 0 && (
                <span className="ml-1 text-warning">{tasksOpen}</span>
              )}
              <Tabs.Indicator />
            </Tabs.Tab>
            <Tabs.Tab id="threads">
              Threads
              {unresolved > 0 && (
                <span className="ml-1 text-warning">{unresolved}</span>
              )}
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

const FindingCard = observer(function FindingCard({
  pr,
  f,
}: {
  pr: PrId;
  f: Finding;
}) {
  const store = useRootStore();
  return (
    <Card
      className={`finding mt-1 gap-2 px-4 py-3 ${f.state === 'drafted' ? 'opacity-60' : ''}`}
    >
      <div className="flex items-center gap-1.5">
        <Sev s={f.severity} />
        <b>{f.title}</b>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {f.agents.map((a) => (
          <AgentTag key={a} id={a} />
        ))}
      </div>
      <div className="rich text-sm text-muted">{rich(f.body)}</div>
      {f.fix?.patch && (
        <PatchView
          patch={f.fix.patch}
          status={
            f.fix.status === 'applied'
              ? 'applied'
              : f.fix.status === 'rejected'
                ? 'rejected'
                : undefined
          }
        />
      )}
      {f.state !== 'drafted' && (
        <div className="flex flex-wrap gap-1">
          <Btn
            icon={<ListCheck />}
            onPress={() => findingToDraft(store, pr, f)}
          >
            Add to review
          </Btn>
          <Btn tone="tertiary" onPress={() => ignoreFinding(store, f.id)}>
            Ignore
          </Btn>
        </div>
      )}
    </Card>
  );
});

const Chat = observer(function Chat({ pr }: { pr: PrId }) {
  const store = useRootStore();
  const [text, setText] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const messages = store.models.chatMessages
    .where((m) => m.pr === pr)
    .sort((a, b) => a.at - b.at);
  const runs = store.models.skillRuns.where((r) => r.pr === pr);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [messages.length]);

  const send = () => {
    const t = text.trim();
    if (!t) return;
    if (t.startsWith('/')) {
      void runSkill(store, pr, t.slice(1).split(' ')[0] ?? '');
    } else {
      void ask(store, {
        pr,
        question: t,
        about: null,
        group: null,
        agent: null,
      });
    }
    setText('');
  };

  return (
    <div className="chat flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto px-4 py-5">
        {messages.length === 0 && runs.length === 0 && (
          <div className="m-auto flex flex-col items-center gap-2 text-center text-sm text-muted">
            <Sparkles className="size-5" />
            Ask about this PR, or type /skill-name to run a skill.
          </div>
        )}
        {runs.map((r) => (
          <SkillRunView key={r.id} pr={pr} run={r.id} />
        ))}
        {messages.map((m) => (
          <div
            key={m.id}
            className={`msg flex ${m.author.kind === 'me' ? 'justify-end' : 'gap-3'}`}
          >
            {m.author.kind === 'me' ? (
              <div className="rich max-w-[85%] whitespace-pre-wrap rounded-3xl bg-default px-4 py-2 text-sm">
                {rich(m.text)}
              </div>
            ) : (
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <AgentTag id={m.author.agent} />
                <div className="rich whitespace-pre-wrap text-sm leading-relaxed">
                  {rich(m.text)}
                </div>
              </div>
            )}
          </div>
        ))}
        <div ref={end} />
      </div>
      <div className="chat-input flex flex-col gap-2 border-t border-separator px-4 pb-3 pt-3">
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
              placeholder="Ask about the code, or /skill-name to run a skill"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <InputGroup.Suffix className="flex w-full items-center justify-end px-2.5 py-0">
              <Button
                isIconOnly
                size="sm"
                aria-label="Send"
                className="rounded-full"
                isDisabled={!text.trim()}
                onPress={send}
              >
                <ArrowUp className="size-4" />
              </Button>
            </InputGroup.Suffix>
          </InputGroup>
        </TextField>
      </div>
    </div>
  );
});

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
  const findings = store.models.findings.where(
    (f) => f.pr === pr && f.skill === r?.skill,
  );
  if (!r) return null;
  return (
    <div className="skill flex flex-col gap-2.5">
      <div className="flex items-center gap-2 text-sm">
        <span className="min-w-0 flex-1 font-mono">/{r.skill}</span>
        <span className="text-xs text-muted">{r.status}</span>
        {r.status === 'running' && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs"
            onPress={() => void cancelRun(store, run)}
          >
            <CircleStop className="size-3.5" />
            Stop
          </Button>
        )}
      </div>
      {r.status === 'running' && log.length > 0 && (
        <pre className="runlog max-h-32 overflow-auto rounded-xl bg-background-secondary px-3 py-2 font-mono text-xs text-muted">
          {log.join('\n')}
        </pre>
      )}
      {r.error && <div className="text-xs text-danger">{r.error}</div>}
      {findings.map((f) => (
        <FindingCard key={f.id} pr={pr} f={f} />
      ))}
    </div>
  );
});

const PrTasks = observer(function PrTasks({ pr }: { pr: PrId }) {
  const store = useRootStore();
  const ui = useUi();
  const tasks = store.models.tasks.where((t) => t.pr === pr);
  return (
    <ListBox
      aria-label="PR tasks"
      selectionMode="none"
      renderEmptyState={() => (
        <EmptyState className="rounded-2xl border border-dashed border-separator p-4 text-sm">
          No tasks yet.
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

// `pr` is unused until `Thread` carries one (see the final report) — kept in
// the signature so this becomes a one-line fix once the contract has it.
const Threads = observer(function Threads({ pr: _pr }: { pr: PrId }) {
  const store = useRootStore();
  const open = store.models.threads.where((t) => !t.resolved);
  const resolved = store.models.threads.where((t) => t.resolved);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
      {open.length === 0 && resolved.length === 0 && (
        <Typography.Paragraph size="sm" color="muted" align="center">
          No threads yet.
        </Typography.Paragraph>
      )}
      {[...open, ...resolved].map((t) => (
        <Card key={t.id} className="flex flex-col gap-2 p-3">
          <div className="flex items-center gap-2 text-xs">
            <Avatar person={t.comments[0]!.author} size={18} />
            <span className="font-medium">{t.comments[0]!.author.login}</span>
            <span className="flex-1" />
            {!t.resolved && (
              <Btn
                tone="tertiary"
                icon={<Check />}
                onPress={() => resolveThread(store, t.id, true)}
              >
                Resolve
              </Btn>
            )}
          </div>
          <p className="line-clamp-3 text-sm text-muted">
            {t.comments.at(-1)!.body}
          </p>
        </Card>
      ))}
    </div>
  );
});
