/**
 * The hero: a space on "mac-studio" works on a change, asks one question, the
 * phone shows it as a push, one tap answers it, the agent finishes and opens
 * a PR. The window is the desktop's space page built from the app's pieces;
 * the phone shows the push as the phone app renders it.
 *
 * Choreography: one sequence, cast as lead (the question, then the push, then
 * the answer flying back) and support (the tool rows, which rise in as they
 * are reached); the chrome is static. The push is thrown (a short overshoot)
 * and the phone buzzes; the tap ripples at the point of touch; the answer
 * flies to the computer along a measured path; the test result and the PR
 * chip land with a small pop. Everything else enters with an ease-out.
 * Reduced motion keeps the key frame. The loop pauses while the hero is off
 * screen or the tab is hidden.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Spinner } from '@heroui/react';
import { CodePullRequest, Eye, Pencil, Terminal } from '@gravity-ui/icons';
import { Phone } from '../components/Phone';
import { Window, WindowHeader } from '../components/Window';
import { LogoArt } from '../shared/LogoArt';
import { Ring } from '../shared/Ring';
import {
  AgentText,
  QuestionCard,
  ToolRow,
  UserBubble,
  WaitDot,
} from '../mocks/chat';
import { KEY, LOOP, LOOP_MS, reached, statusOf, type Phase } from './timeline';

const QUESTION =
  'Should people go back to the page they came from, or always to Home?';
const OPTIONS = ['The page they came from', 'Always Home'];

function usePhase(ref: React.RefObject<HTMLElement | null>): Phase {
  // The server and the first client render agree on the key frame; the loop
  // starts after hydration, only while the hero is on screen.
  const [phase, setPhase] = useState<Phase>(KEY);
  useEffect(() => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let timers: number[] = [];
    let loop: number | undefined;
    let visible = false;
    const stop = () => {
      timers.forEach(clearTimeout);
      timers = [];
      if (loop !== undefined) clearInterval(loop);
      loop = undefined;
    };
    const run = () => {
      timers.forEach(clearTimeout);
      timers = LOOP.map(([p, at]) => window.setTimeout(() => setPhase(p), at));
    };
    const start = () => {
      stop();
      setPhase(KEY);
      run();
      loop = window.setInterval(run, LOOP_MS);
    };
    const sync = () => {
      if (visible && document.visibilityState === 'visible') {
        if (loop === undefined) start();
      } else {
        stop();
        setPhase(KEY);
      }
    };
    const io = new IntersectionObserver(
      ([e]) => {
        visible = !!e?.isIntersecting;
        sync();
      },
      { threshold: 0.3 },
    );
    if (ref.current) io.observe(ref.current);
    document.addEventListener('visibilitychange', sync);
    return () => {
      stop();
      io.disconnect();
      document.removeEventListener('visibilitychange', sync);
    };
  }, [ref]);
  return phase;
}

/** The answer flies from the tapped option on the phone to the question
 *  card on the computer: the path is measured when it starts, and the
 *  flyer is animated on transform only. */
function useFlight(
  go: boolean,
  scene: React.RefObject<HTMLElement | null>,
  from: React.RefObject<HTMLElement | null>,
  to: React.RefObject<HTMLElement | null>,
  flyer: React.RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (!go) return;
    const s = scene.current;
    const a = from.current?.getBoundingClientRect();
    const b = to.current?.getBoundingClientRect();
    const f = flyer.current;
    if (!s || !a || !b || !f) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const base = s.getBoundingClientRect();
    // Where it lands, as part of the animation itself (held by `fill`), so
    // nothing is written to the element outside it.
    const at = {
      left: `${b.left - base.left}px`,
      top: `${b.top - base.top}px`,
      width: `${a.width}px`,
    };
    const dx = a.left - b.left;
    const dy = a.top - b.top;
    const anim = f.animate(
      [
        { ...at, transform: `translate(${dx}px, ${dy}px)`, opacity: 1 },
        {
          ...at,
          transform: `translate(${dx * 0.3}px, ${dy * 0.3 - 18}px)`,
          opacity: 1,
          offset: 0.6,
        },
        { ...at, transform: 'translate(0, 0) scale(0.92)', opacity: 0 },
      ],
      { duration: 640, easing: 'cubic-bezier(0.23, 1, 0.32, 1)', fill: 'both' },
    );
    return () => anim.cancel();
  }, [go, scene, from, to, flyer]);
}

/** A chat row that takes no space until it is reached. */
function Row({ on, children }: { on: boolean; children: ReactNode }) {
  return (
    <div className="demo-row" data-on={on}>
      <div>{children}</div>
    </div>
  );
}

function Status({ phase }: { phase: Phase }) {
  const s = statusOf(phase);
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-t border-separator px-4 text-xs text-muted">
      {s.kind === 'working' && (
        <Spinner size="sm" color="current" className="size-3" />
      )}
      {s.kind === 'waiting' && <WaitDot />}
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
  const ref = useRef<HTMLDivElement>(null);
  const optionRef = useRef<HTMLSpanElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const flyerRef = useRef<HTMLDivElement>(null);
  const phase = usePhase(ref);
  const on = (p: Phase) => reached(phase, p);
  const answered = on('answered');
  useFlight(phase === 'sent', ref, optionRef, cardRef, flyerRef);
  return (
    <div
      ref={ref}
      className="relative mx-auto flex w-full max-w-[640px] flex-col items-center gap-6 lg:mx-0 lg:block lg:max-w-none lg:pb-10 lg:pe-32 xl:pe-36"
    >
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
        className="w-full"
      >
        <WindowHeader
          title="Fix the login redirect"
          chip={on('pr') ? 'In review' : 'Drafting'}
          chipPop={on('pr')}
          right={<span className="text-xs text-muted">on mac-studio</span>}
        />
        {/* A column-reverse box: new rows push older ones out of the top. */}
        <div className="chat-log flex h-[352px] flex-col-reverse overflow-hidden px-4 pb-4 md:h-[318px] lg:pe-20">
          <div className="flex flex-col gap-3">
            <Row on={on('start')}>
              <UserBubble>
                After signing in, people land on the wrong page. Fix it.
              </UserBubble>
            </Row>
            <div className="flex flex-col gap-1.5">
              <Row on={on('read1')}>
                <ToolRow icon={Eye} verb="Read" label="src/auth/session.ts" />
              </Row>
              <Row on={on('read2')}>
                <ToolRow icon={Eye} verb="Read" label="src/routes/login.tsx" />
              </Row>
              <Row on={on('edit1')}>
                <ToolRow
                  icon={Pencil}
                  verb="Edit"
                  label="src/auth/redirect.ts"
                  added={12}
                  removed={3}
                />
              </Row>
              <Row on={on('ask')}>
                <div ref={cardRef}>
                  <QuestionCard
                    question={QUESTION}
                    options={OPTIONS}
                    picked={on('tap') ? OPTIONS[0] : undefined}
                    answered={answered}
                    answeredFrom="iPhone"
                    className="my-1.5"
                  />
                </div>
              </Row>
              <Row on={on('edit2')}>
                <ToolRow
                  icon={Pencil}
                  verb="Edit"
                  label="src/routes/login.tsx"
                  added={5}
                />
              </Row>
              <Row on={on('test')}>
                <ToolRow
                  icon={Terminal}
                  verb="Run"
                  label="pnpm test"
                  busy={!on('pass')}
                  note={
                    <span
                      className="demo-pop inline-flex items-center gap-1 text-success"
                      data-on={on('pass')}
                    >
                      <Ring
                        color="var(--success)"
                        check
                        title="Passed"
                        size={12}
                      />
                      214 passed
                    </span>
                  }
                />
              </Row>
              <Row on={on('pr')}>
                <ToolRow
                  icon={CodePullRequest}
                  verb="Opened"
                  label="pull request #482"
                  mono={false}
                />
              </Row>
            </div>
            <Row on={on('pr')}>
              <AgentText>
                People now return to the page they came from after signing in;
                the redirect is kept in the session. Tests pass. Opened PR #482
                for review.
              </AgentText>
            </Row>
          </div>
        </div>
        <Status phase={phase} />
      </Window>

      <Phone
        size="sm"
        data-buzz={phase === 'notify'}
        className="demo-phone lg:absolute lg:bottom-0 lg:right-0"
        label="A phone's lock screen: a push from mac-studio asks the question with its answers as buttons; one tap answers it"
      >
        <div className="mt-1 text-center text-[40px] font-semibold leading-none tracking-tight tabular-nums">
          9:41
        </div>
        <div className="mb-4 mt-1.5 text-center text-[11px] text-muted">
          Saturday, on the train
        </div>
        <div
          className="demo-notif rounded-2xl bg-surface p-2.5 text-[11.5px] shadow-card"
          data-on={on('notify')}
        >
          <div className="mb-1 flex items-center gap-1.5 text-[10.5px] text-muted">
            <LogoArt size={13} />
            <span className="min-w-0 flex-1 truncate">
              mac-studio · Fix the login redirect
            </span>
            {!on('sent') && <WaitDot />}
          </div>
          <p className="mb-2 leading-snug">{QUESTION}</p>
          {on('sent') ? (
            <div
              className="demo-pop flex items-center gap-1.5 rounded-xl bg-default px-2 py-1.5 font-medium"
              data-on
            >
              <Ring color="var(--success)" check title="Sent" size={12} />
              <span className="min-w-0 truncate">{OPTIONS[0]}</span>
            </div>
          ) : (
            <div className="grid gap-1.5">
              {OPTIONS.map((o, i) => (
                <span
                  key={o}
                  ref={i === 0 ? optionRef : undefined}
                  data-pressed={i === 0 && on('tap')}
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
          )}
        </div>
        <div
          className="demo-fade mt-2 text-center text-[11px] text-muted"
          data-on={on('sent')}
        >
          Sent to mac-studio
        </div>
        {/* An older notification, so the lock screen reads as a lock screen. */}
        <div className="mt-auto rounded-2xl bg-surface/70 p-2.5 text-[11px] text-muted">
          <div className="mb-0.5 flex items-center gap-1.5 text-[10.5px]">
            <LogoArt size={13} />
            <span className="min-w-0 flex-1 truncate">
              mac-studio · add-csv-export
            </span>
            <span className="shrink-0">2h</span>
          </div>
          Done · pull request #479 opened
        </div>
      </Phone>

      {/* The answer in flight (positioned and animated by useFlight). */}
      <div
        ref={flyerRef}
        aria-hidden
        className="demo-flyer rounded-xl bg-accent px-2 py-1.5 text-center text-[11.5px] font-medium text-accent-foreground shadow-card"
      >
        {OPTIONS[0]}
      </div>
    </div>
  );
}
