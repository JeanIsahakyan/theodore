/**
 * The phone app on a running space (docs/mobile.md "Space", "Activity
 * strip", "Attachments"): a scene. A photo of the whiteboard uploads with a
 * progress ring and lands in the chat, the agent reads it and asks one
 * question, a tap answers it. Archive lives in the space's long-press menu,
 * so the header shows none of it.
 */
import { useRef } from 'react';
import { ChevronRight, Paperclip } from '@gravity-ui/icons';
import { Spinner } from '@heroui/react';
import { Phone } from '../components/Phone';
import { useScene } from '../demo/useScene';
import { Ring } from '../shared/Ring';
import { WaitDot } from './chat';

/** A photo of a whiteboard, drawn rather than fetched: a few strokes. */
function Whiteboard({ className = '' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 160 96"
      className={`h-auto w-full rounded-xl bg-[#ecebe6] ${className}`}
      aria-label="A photo of a whiteboard sketch"
      role="img"
    >
      <rect x="8" y="8" width="144" height="80" rx="4" fill="#f7f6f2" />
      <g
        fill="none"
        stroke="#2b4bb3"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="22" y="22" width="40" height="22" rx="3" />
        <rect x="98" y="22" width="40" height="22" rx="3" />
        <path d="M62 33 h30 m-6 -5 l6 5 -6 5" />
        <rect x="60" y="58" width="40" height="22" rx="3" />
        <path d="M42 44 v8 q0 6 6 6 h12 m-6 -5 l6 5 -6 5" />
        <path d="M118 44 v8 q0 6 -6 6 h-12 m6 -5 l-6 5 6 5" />
      </g>
      <g stroke="#c0392b" strokeWidth="2" strokeLinecap="round" fill="none">
        <path d="M30 31 h22" />
        <path d="M68 69 h22" />
      </g>
    </svg>
  );
}

/** The upload's progress ring, over the attached photo in the composer. */
function UploadRing({ progress }: { progress: number }) {
  const r = 9;
  const c = 2 * Math.PI * r;
  return (
    <svg
      viewBox="0 0 24 24"
      className="demo-ring size-6"
      role="img"
      aria-label={progress >= 1 ? 'Uploaded' : 'Uploading'}
    >
      <circle
        cx="12"
        cy="12"
        r={r}
        fill="none"
        stroke="var(--separator)"
        strokeWidth="2.5"
      />
      <circle
        cx="12"
        cy="12"
        r={r}
        fill="none"
        stroke="var(--accent)"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - progress)}
        transform="rotate(-90 12 12)"
      />
    </svg>
  );
}

/** Steps: 1 the upload runs; 2 the photo and message land in the chat;
 *  3 the agent replies; 4 it asks; 5 you tap; 6 the answer is sent. */
const AT = [400, 1500, 2300, 3000, 4500, 5000];

export function PhoneMock() {
  const ref = useRef<HTMLDivElement>(null);
  const step = useScene(ref, AT);
  const sent = step >= 2;
  const asked = step >= 4;
  const answered = step >= 6;
  const status = answered
    ? 'Running'
    : asked
      ? 'Waiting'
      : step >= 3
        ? 'Running'
        : 'Idle';
  return (
    <div ref={ref} className="flex justify-center lg:justify-end lg:pe-10">
      <Phone label="The phone app on a space: a photo of a whiteboard you attached uploads and lands in the chat, the agent asks a question with its options, one tap answers it; the activity strip above the composer says what the agent is doing">
        <div className="flex items-center gap-2 px-1 text-[11px] text-muted">
          <span className="text-base leading-none">☰</span>
          <span className="min-w-0 flex-1 truncate text-center">
            <span className="block text-[13px] font-semibold text-foreground">
              Fix the flaky test
            </span>
            on mac-studio · {status}
          </span>
          <span className="text-base leading-none">✎</span>
        </div>
        {/* A column-reverse box: new messages push older ones out of the top. */}
        <div className="mt-3 flex flex-1 flex-col-reverse overflow-hidden text-[12px]">
          <div className="flex flex-col gap-3">
            <p className="leading-snug text-foreground">
              Which flow should the retry follow? I see two in the code.
            </p>
            <div className="demo-row" data-on={sent}>
              <div className="flex flex-col items-end gap-1.5">
                <div className="w-[62%] rounded-2xl bg-surface p-1.5 pb-1 shadow-card">
                  <Whiteboard />
                  <span className="mt-1 flex items-center gap-1 px-1 text-[10.5px] text-muted">
                    <Paperclip className="size-3" />
                    whiteboard.jpg
                  </span>
                </div>
                <div className="max-w-[85%] rounded-2xl bg-surface px-3 py-1.5">
                  The flow we agreed on. Make the retry match it.
                </div>
              </div>
            </div>
            <div className="demo-row" data-on={step >= 3}>
              <p className="leading-snug text-foreground">
                The sketch retries the upload, not the whole job. One thing is
                open:
              </p>
            </div>
            <div className="demo-row" data-on={asked}>
              <div className="flex flex-col gap-2 rounded-2xl bg-surface px-3 py-2.5 shadow-card">
                <span className="flex items-center gap-1.5 text-[10.5px] font-medium text-muted">
                  {answered ? (
                    'Answered'
                  ) : (
                    <>
                      <WaitDot pulse />
                      Waiting for your answer
                    </>
                  )}
                </span>
                <span className="font-medium leading-snug">
                  Give up after 3 retries, or keep trying for a minute?
                </span>
                {answered ? (
                  <div
                    className="demo-pop flex items-center gap-1.5 rounded-xl bg-default px-2 py-1.5 font-medium"
                    data-on
                  >
                    <Ring color="var(--success)" check title="Sent" size={12} />
                    3 retries
                  </div>
                ) : (
                  <div className="grid gap-1.5">
                    <span
                      data-pressed={step >= 5}
                      className={`demo-tap rounded-xl px-2 py-1.5 text-center font-medium ${
                        step >= 5
                          ? 'bg-accent text-accent-foreground'
                          : 'bg-default'
                      }`}
                    >
                      3 retries
                    </span>
                    <span className="rounded-xl bg-default px-2 py-1.5 text-center font-medium">
                      Keep trying for a minute
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
        <div className="mt-3 flex flex-col gap-2">
          {/* The activity strip: what the agent is doing right now. */}
          <div className="rounded-xl bg-surface px-3 py-2 text-[11px] shadow-card">
            <div className="flex items-center gap-1.5">
              {asked && !answered ? (
                <WaitDot />
              ) : (
                <Spinner
                  size="sm"
                  color="current"
                  className="size-2.5 text-muted"
                />
              )}
              <span className="min-w-0 flex-1 truncate">
                {answered
                  ? 'Edit src/jobs/retry.ts · 3 of 4'
                  : asked
                    ? 'Waiting for you · 2 of 4'
                    : step >= 3
                      ? 'Read the sketch · 2 of 4'
                      : 'Read src/jobs/retry.ts · 1 of 4'}
              </span>
              <span className="tabular-nums text-muted">4m 12s</span>
            </div>
            <div className="mt-1 flex items-center gap-1.5 text-muted">
              <Ring
                color="var(--muted)"
                fill={0.5}
                title="Sub-space"
                size={10}
              />
              <span className="min-w-0 flex-1 truncate">
                sub-space of migrate-billing-schema
              </span>
              <ChevronRight className="size-3 -rotate-90" />
            </div>
          </div>
          {/* The composer: the photo attached and uploading, then empty. */}
          <div className="flex flex-col gap-2 rounded-2xl bg-surface px-3 pb-2 pt-2.5 text-[11px] shadow-card">
            {sent ? (
              <span className="text-muted">Add to the queue…</span>
            ) : (
              <div className="flex items-center gap-2">
                <span className="relative w-14 shrink-0 overflow-hidden rounded-lg">
                  <Whiteboard />
                  <span className="absolute inset-0 grid place-items-center bg-background/50">
                    <UploadRing progress={step >= 1 ? 1 : 0} />
                  </span>
                </span>
                <span className="min-w-0 flex-1 truncate text-foreground">
                  The flow we agreed on. Make the retry match it.
                </span>
              </div>
            )}
            <div className="flex items-center gap-1">
              <Paperclip className="size-3.5 text-muted" />
              <span className="inline-flex h-6 items-center gap-1 rounded-full bg-default px-2">
                Opus · High
                <ChevronRight className="size-3 rotate-90 text-muted" />
              </span>
              <span className="ms-auto grid size-6 place-items-center rounded-full bg-accent text-accent-foreground">
                ↑
              </span>
            </div>
          </div>
        </div>
      </Phone>
    </div>
  );
}
