/**
 * A space with sub-spaces: the sidebar's Spaces section with its tree
 * (Sidebar.tsx), and the chat's sub-space tool rows (SpaceToolRow.tsx).
 */
import { Spinner } from '@heroui/react';
import {
  ArrowUturnCcwLeft,
  Check,
  ChevronRight,
  CircleQuestion,
  CodeFork,
  CodeMerge,
  CodePullRequest,
  Eye,
  Hourglass,
  Magnifier,
  Plus,
} from '@gravity-ui/icons';
import { MockBtn, Window, WindowHeader } from '../components/Window';
import { Ring } from '../shared/Ring';
import {
  AgentText,
  Composer,
  LineCounts,
  ROW,
  StepIcon,
  UserBubble,
} from './chat';

function NavRow({
  label,
  count,
  current,
}: {
  label: string;
  count?: number;
  current?: boolean;
}) {
  return (
    <div
      className={`nav flex h-8 items-center gap-3 rounded-lg px-3 text-[13px] ${current ? 'bg-default font-medium' : ''}`}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count != null && (
        <span className="text-xs tabular-nums text-muted">{count}</span>
      )}
    </div>
  );
}

function Glyph({
  kind,
}: {
  kind: 'running' | 'new' | 'idle' | 'done' | 'asking' | 'pr';
}) {
  switch (kind) {
    case 'running':
      return (
        <Spinner size="sm" color="current" className="size-3 text-muted" />
      );
    case 'new':
      return <span className="size-2 rounded-full bg-accent" />;
    case 'idle':
      return <Ring color="var(--muted)" title="Idle" size={12} />;
    case 'done':
      return <Ring color="var(--accent)" check title="Merged" size={12} />;
    case 'asking':
      return <CircleQuestion className="size-3.5 text-accent" />;
    case 'pr':
      return <CodePullRequest className="size-3.5 text-success" />;
  }
}

function SpaceRow({
  glyph,
  label,
  depth = 0,
  current,
  right,
}: {
  glyph: Parameters<typeof Glyph>[0]['kind'];
  label: string;
  depth?: number;
  current?: boolean;
  right?: string;
}) {
  return (
    <div
      className={`nav flex h-8 items-center gap-2.5 rounded-lg pe-2 text-[13px] ${current ? 'bg-default font-medium' : ''}`}
      style={{ paddingInlineStart: `${12 + depth * 14}px` }}
    >
      <span className="grid size-4 shrink-0 place-items-center text-muted">
        <Glyph kind={glyph} />
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {right && <span className="shrink-0 text-xs text-muted">{right}</span>}
    </div>
  );
}

function Sidebar() {
  return (
    <>
      <div className="flex items-center gap-2 px-3 pb-2 pt-3 text-[13px] font-medium">
        <Ring color="var(--accent)" fill={1} title="Project" size={12} />
        acme/storefront
        <ChevronRight className="size-3 rotate-90 text-muted" />
        <span className="ms-auto grid size-6 place-items-center rounded-lg text-muted">
          <Magnifier className="size-3.5" />
        </span>
      </div>
      <div className="flex flex-col gap-0.5 px-2">
        <NavRow label="Overview" />
        <NavRow label="Inbox" count={2} />
        <NavRow label="My PRs" count={1} />
        <NavRow label="Tasks" />
        <NavRow label="Skills" />
      </div>
      <div className="flex items-center justify-between pb-1 pe-3 ps-5 pt-5 text-xs text-muted">
        Spaces
        <Plus className="size-3.5" />
      </div>
      <div className="flex flex-col gap-0.5 px-2">
        <SpaceRow
          glyph="running"
          label="migrate-billing-schema"
          current
          right="3"
        />
        <SpaceRow glyph="done" label="Move the types" depth={1} />
        <SpaceRow glyph="running" label="Port the parser" depth={1} />
        <SpaceRow glyph="asking" label="Fix the flaky test" depth={1} />
        <SpaceRow glyph="new" label="add-csv-export" />
        <SpaceRow glyph="pr" label="#123 rate-limits" />
        <SpaceRow glyph="idle" label="tidy-config" />
      </div>
    </>
  );
}

function SubSpaceRow({
  icon: Icon,
  verb,
  name,
  rest,
  stage,
  busy,
}: {
  icon: typeof CodeFork;
  verb: string;
  name: string;
  rest?: React.ReactNode;
  stage?: 'running' | 'merged' | 'asking';
  busy?: boolean;
}) {
  return (
    <div className={ROW}>
      <StepIcon busy={busy}>
        <Icon />
      </StepIcon>
      <span className="shrink-0 text-muted">{verb}</span>
      <span className="min-w-0 truncate font-medium">{name}</span>
      {stage && (
        <span
          className={`inline-flex shrink-0 items-center gap-1 rounded-full bg-default px-1.5 py-0.5 text-[11px] ${stage === 'asking' ? 'text-accent' : 'text-muted'}`}
        >
          {stage === 'running' && (
            <Spinner size="sm" color="current" className="size-2.5" />
          )}
          {stage === 'merged' && <Check className="size-3" />}
          {stage === 'running'
            ? 'running'
            : stage === 'merged'
              ? 'merged'
              : 'waiting for you'}
        </span>
      )}
      {rest}
      <ChevronRight className="ms-auto size-3.5 shrink-0 text-muted" />
    </div>
  );
}

export function SpacesMock() {
  return (
    <Window
      tab="migrate-billing-schema"
      tabIcon={
        <Spinner size="sm" color="current" className="size-3 text-muted" />
      }
      sidebar={<Sidebar />}
      label="A space whose agent split the work into three sub-spaces, one merged, one running, one waiting for an answer; the sidebar lists them under their parent"
      className="min-h-[480px]"
    >
      <WindowHeader
        title="Migrate the billing schema"
        chip="Drafting"
        right={
          <>
            <MockBtn tone="ghost" icon={<ArrowUturnCcwLeft />}>
              Undo
            </MockBtn>
            <MockBtn icon={<Eye />}>Review</MockBtn>
            <MockBtn tone="primary" icon={<CodePullRequest />}>
              Open PR
            </MockBtn>
          </>
        }
      />
      <div className="flex flex-1 flex-col gap-4 px-4 py-4">
        <UserBubble>
          Split the billing table into accounts and invoices. Keep the old reads
          working until the backfill is done.
        </UserBubble>
        <div className="flex flex-col gap-2">
          <AgentText>
            Three independent parts. Starting them as sub-spaces so they run
            side by side; I'll merge each one back here.
          </AgentText>
          <SubSpaceRow
            icon={CodeFork}
            verb="Sub-space started:"
            name="Move the types"
            stage="merged"
          />
          <SubSpaceRow
            icon={CodeFork}
            verb="Sub-space started:"
            name="Port the parser"
            stage="running"
          />
          <SubSpaceRow
            icon={CodeFork}
            verb="Sub-space started:"
            name="Fix the flaky test"
            stage="asking"
          />
          <SubSpaceRow
            icon={CodeMerge}
            verb="Merged"
            name="Move the types"
            rest={
              <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted">
                4 files <LineCounts added={120} removed={8} />
              </span>
            }
          />
          <SubSpaceRow
            icon={Hourglass}
            verb="Waiting for"
            name="2 sub-spaces"
            rest={
              <span className="shrink-0 text-xs text-muted">
                1 running · 1 waiting
              </span>
            }
            busy
          />
        </div>
        <div className="mt-auto">
          <Composer
            placeholder="Add to the queue…"
            chips={['Edit', 'Claude · Opus 4.1 · High']}
          />
        </div>
      </div>
    </Window>
  );
}
