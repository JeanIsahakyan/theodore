/**
 * Pieces of a space's chat as the desktop draws them (ui/src/ui/ChatTurn.tsx,
 * TurnTimeline.tsx, turnBits.tsx, SpacePlan.tsx `QuestionCard`): your bubble,
 * a tool row with its icon and line counts, a question card, the agent's
 * reply. Static, for the mocks on this site.
 */
import type { ComponentType, ReactNode } from 'react';
import { Button, Card, Chip, Spinner, ToggleButton } from '@heroui/react';
import { ChevronRight } from '@gravity-ui/icons';

export const ROW = 'flex min-w-0 items-center gap-1.5 text-[13px]';

export function UserBubble({ children }: { children: ReactNode }) {
  return (
    <div className="chat-message msg user flex justify-end">
      <div className="user-bubble max-w-[85%] whitespace-pre-wrap rounded-3xl bg-surface px-4 py-2 text-sm [overflow-wrap:anywhere]">
        {children}
      </div>
    </div>
  );
}

export function StepIcon({
  busy,
  children,
}: {
  busy?: boolean;
  children: ReactNode;
}) {
  return (
    <span className="grid size-4 shrink-0 place-items-center text-muted [&>svg]:size-3.5">
      {busy ? (
        <Spinner size="sm" color="current" className="size-3" />
      ) : (
        children
      )}
    </span>
  );
}

export function LineCounts({
  added,
  removed,
}: {
  added?: number;
  removed?: number;
}) {
  return (
    <>
      {added != null && (
        <span className="shrink-0 font-mono text-[11px] text-success">
          +{added}
        </span>
      )}
      {removed != null && (
        <span className="shrink-0 font-mono text-[11px] text-danger">
          −{removed}
        </span>
      )}
    </>
  );
}

/** One tool call: `Read src/auth/session.ts`, `Edit … +12 −3`. */
export function ToolRow({
  icon: Icon,
  verb,
  label,
  note,
  added,
  removed,
  busy,
  mono = true,
  className = '',
  ...rest
}: {
  icon: ComponentType<{ className?: string }>;
  verb: string;
  label: string;
  note?: ReactNode;
  added?: number;
  removed?: number;
  busy?: boolean;
  mono?: boolean;
  className?: string;
  'data-on'?: boolean;
}) {
  return (
    <div className={`turn-tool ${ROW} ${className}`} {...rest}>
      <StepIcon busy={busy}>
        <Icon />
      </StepIcon>
      <span className="shrink-0 text-muted">{verb}</span>
      <span
        className={`min-w-0 truncate ${mono ? 'font-mono text-[12px]' : ''}`}
      >
        {label}
      </span>
      <LineCounts added={added} removed={removed} />
      {note && <span className="shrink-0 text-xs text-muted">{note}</span>}
      <ChevronRight className="ms-auto size-3.5 shrink-0 text-muted" />
    </div>
  );
}

/** The card an `ask_user` question shows (SpacePlan.tsx). `answered`
 *  collapses it to who answered and what. */
export function QuestionCard({
  question,
  options,
  picked,
  answered,
  answeredFrom,
  className = '',
  ...rest
}: {
  question: string;
  options: string[];
  picked?: string;
  answered?: boolean;
  answeredFrom?: string;
  className?: string;
  'data-on'?: boolean;
}) {
  return (
    <Card
      variant="secondary"
      className={`space-question flex flex-col gap-3 px-4 py-3 ${className}`}
      {...rest}
    >
      <span className="text-xs font-medium text-muted">
        {answered
          ? `Answered from ${answeredFrom ?? 'your phone'}`
          : 'The agent is waiting for your answer'}
      </span>
      <span className="text-sm font-medium">{question}</span>
      {answered ? (
        <div className="flex flex-wrap gap-1.5">
          <Chip size="sm" variant="soft" color="accent">
            {picked}
          </Chip>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-1.5">
            {options.map((o) => (
              <ToggleButton
                key={o}
                size="sm"
                isSelected={picked === o}
                className="space-option pointer-events-none"
                excludeFromTabOrder
                aria-hidden
              >
                {o}
              </ToggleButton>
            ))}
          </div>
          <div className="flex gap-1.5">
            <Button
              size="sm"
              variant="primary"
              isDisabled={!picked}
              className="pointer-events-none"
              excludeFromTabOrder
              aria-hidden
            >
              Send answer
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

/** The agent's reply text. */
export function AgentText({
  children,
  className = '',
  ...rest
}: {
  children: ReactNode;
  className?: string;
  'data-on'?: boolean;
}) {
  return (
    <div className={`turn-text text-sm leading-relaxed ${className}`} {...rest}>
      {children}
    </div>
  );
}

/** The composer under a chat (space/Composer.tsx): the box, its chips, Send. */
export function Composer({
  placeholder,
  chips,
}: {
  placeholder: string;
  chips: string[];
}) {
  return (
    <div className="composer flex flex-col gap-2 rounded-3xl border border-separator bg-surface px-3 pb-2 pt-3">
      <span className="px-1 text-sm text-muted">{placeholder}</span>
      <div className="flex items-center gap-1.5">
        {chips.map((c) => (
          <span
            key={c}
            className="inline-flex h-7 items-center gap-1 rounded-full bg-default px-3 text-xs"
          >
            {c}
            <ChevronRight className="size-3 rotate-90 text-muted" />
          </span>
        ))}
        <span className="flex-1" />
        <span className="grid size-7 place-items-center rounded-full bg-accent text-accent-foreground">
          <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden>
            <path
              d="M8 13V3m0 0L4 7m4-4 4 4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </div>
    </div>
  );
}
