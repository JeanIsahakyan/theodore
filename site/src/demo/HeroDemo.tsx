/**
 * The hero: a space on "mac-studio" works on a change, asks one question, the
 * phone shows it as a notification, one tap answers it, the agent finishes
 * and opens a PR. The window is the desktop's space page built from the
 * app's pieces; the phone shows the push as the phone app renders it.
 */
import { useEffect, useState } from 'react';
import { Spinner } from '@heroui/react';
import { CodePullRequest, Eye, Pencil, Terminal } from '@gravity-ui/icons';
import { Phone } from '../components/Phone';
import { Window, WindowHeader } from '../components/Window';
import { LogoArt } from '../shared/LogoArt';
import { Ring } from '../shared/Ring';
import { AgentText, QuestionCard, ToolRow, UserBubble } from '../mocks/chat';
import {
  AT,
  FINAL,
  LOOP_MS,
  PHASES,
  reached,
  statusOf,
  type Phase,
} from './timeline';

const QUESTION =
  'Should people go back to the page they came from, or always to Home?';
const OPTIONS = ['The page they came from', 'Always Home'];

function usePhase(): Phase {
  // The server and the first client render agree on the finished story;
  // the loop starts after hydration. Reduced motion keeps the final frame.
  const [phase, setPhase] = useState<Phase>(FINAL);
  useEffect(() => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let timers: number[] = [];
    const run = () => {
      timers.forEach(clearTimeout);
      timers = PHASES.map((p) => window.setTimeout(() => setPhase(p), AT[p]));
    };
    run();
    const loop = window.setInterval(run, LOOP_MS);
    return () => {
      timers.forEach(clearTimeout);
      clearInterval(loop);
    };
  }, []);
  return phase;
}

function Status({ phase }: { phase: Phase }) {
  const s = statusOf(phase);
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-t border-separator px-4 text-xs text-muted">
      {s.kind === 'working' && (
        <Spinner size="sm" color="current" className="size-3" />
      )}
      {s.kind === 'waiting' && (
        <Ring color="var(--accent)" fill={0.5} title="Waiting" size={12} />
      )}
      {s.kind === 'done' && (
        <Ring color="var(--success)" check title="Done" size={12} />
      )}
      <span className={s.kind === 'waiting' ? 'text-foreground' : ''}>
        {s.text}
      </span>
    </div>
  );
}

export function HeroDemo() {
  const phase = usePhase();
  const on = (p: Phase) => reached(phase, p);
  const answered = on('answered');
  return (
    <div className="grid grid-cols-1 items-end gap-8 lg:grid-cols-[minmax(0,1fr)_236px]">
      <Window
        tab="Fix the login redirect"
        tabIcon={
          on('pr') ? (
            <Ring color="var(--accent)" title="Open PR" fill={0} />
          ) : (
            <Ring color="var(--accent)" fill={0.3} title="Running" />
          )
        }
        label="Demo: an agent works in a space, asks a question, the answer comes from a phone, and it opens pull request #482"
        className="min-h-[480px]"
      >
        <WindowHeader
          title="Fix the login redirect"
          chip={on('pr') ? 'In review' : 'Drafting'}
          right={<span className="text-xs text-muted">on mac-studio</span>}
        />
        <div className="chat-log flex flex-1 flex-col gap-4 px-4 py-4">
          <UserBubble>
            After signing in, people land on the wrong page. Fix it.
          </UserBubble>
          <div className="flex flex-col gap-2">
            <ToolRow
              icon={Eye}
              verb="Read"
              label="src/auth/session.ts"
              className="demo-step"
              data-on={on('read1')}
            />
            <ToolRow
              icon={Eye}
              verb="Read"
              label="src/routes/login.tsx"
              className="demo-step"
              data-on={on('read2')}
            />
            <ToolRow
              icon={Pencil}
              verb="Edit"
              label="src/auth/redirect.ts"
              added={12}
              removed={3}
              className="demo-step"
              data-on={on('edit1')}
            />
            <QuestionCard
              question={QUESTION}
              options={OPTIONS}
              picked={on('tap') ? OPTIONS[0] : undefined}
              answered={answered}
              answeredFrom="iPhone"
              className="demo-step my-1"
              data-on={on('ask')}
            />
            <ToolRow
              icon={Pencil}
              verb="Edit"
              label="src/routes/login.tsx"
              added={5}
              className="demo-step"
              data-on={on('edit2')}
            />
            <ToolRow
              icon={Terminal}
              verb="Run"
              label="pnpm test"
              note={<span className="text-success">214 passed</span>}
              className="demo-step"
              data-on={on('test')}
            />
            <ToolRow
              icon={CodePullRequest}
              verb="Opened"
              label="pull request #482"
              mono={false}
              className="demo-step"
              data-on={on('pr')}
            />
          </div>
          <AgentText className="demo-step" data-on={on('pr')}>
            People now return to the page they came from after signing in; the
            redirect is kept in the session. Tests pass. Opened PR #482 for
            review.
          </AgentText>
        </div>
        <Status phase={phase} />
      </Window>

      <Phone label="A phone's lock screen: a notification from mac-studio asks the question; one tap answers it">
        <div className="mt-2 text-center text-5xl font-semibold tracking-tight tabular-nums">
          9:41
        </div>
        <div className="mb-6 text-center text-xs text-muted">
          Saturday, on the train
        </div>
        <div
          className="demo-notif rounded-2xl border border-separator bg-surface p-3 text-[12px] shadow-sm"
          data-on={on('notify')}
          data-gone={on('sent')}
        >
          <div className="mb-1 flex items-center gap-1.5 text-[11px] text-muted">
            <LogoArt size={14} />
            mac-studio · Fix the login redirect
          </div>
          <p className="mb-2.5 leading-snug">{QUESTION}</p>
          <div className="grid gap-1.5">
            {OPTIONS.map((o, i) => (
              <span
                key={o}
                className={`demo-tap rounded-xl px-2 py-1.5 text-center font-medium ${
                  i === 0 && on('tap')
                    ? 'bg-accent text-accent-foreground'
                    : 'bg-default'
                }`}
              >
                {o}
              </span>
            ))}
          </div>
        </div>
        <div
          className="demo-sent mt-3 text-center text-xs text-success"
          data-on={on('sent')}
        >
          Sent to mac-studio
        </div>
      </Phone>
    </div>
  );
}
