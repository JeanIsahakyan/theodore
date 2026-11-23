/**
 * The phone app on a running space (docs/mobile.md "Space", "Activity
 * strip", "Attachments"): a question with its options, a photo you
 * attached, the activity strip above the composer. Archive lives in the
 * space's long-press menu, so the header shows none of it.
 */
import { ChevronRight, Paperclip } from '@gravity-ui/icons';
import { Phone } from '../components/Phone';
import { Ring } from '../shared/Ring';
import { SignalDot } from './chat';

/** A photo of a whiteboard, drawn rather than fetched: a few strokes. */
function Whiteboard() {
  return (
    <svg
      viewBox="0 0 160 96"
      className="h-auto w-full rounded-xl bg-[#ecebe6]"
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

export function PhoneMock() {
  return (
    <div className="flex justify-center lg:justify-end lg:pe-10">
      <Phone label="The phone app on a space: a question from the agent with its options, a photo you attached, the archive action, the activity strip above the composer">
        <div className="flex items-center gap-2 px-1 text-[11px] text-muted">
          <span className="text-base leading-none">☰</span>
          <span className="min-w-0 flex-1 truncate text-center">
            <span className="block text-[13px] font-semibold text-foreground">
              Fix the flaky test
            </span>
            on mac-studio · Waiting
          </span>
          <span className="text-base leading-none">✎</span>
        </div>
        <div className="mt-4 flex flex-1 flex-col gap-3 overflow-hidden text-[12px]">
          <div className="flex flex-col items-end gap-1.5">
            <div className="w-[78%] rounded-2xl bg-surface p-1.5 pb-1 shadow-card">
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
          <p className="leading-snug text-foreground">
            The sketch retries the upload, not the whole job. One thing is open:
          </p>
          <div className="flex flex-col gap-2 rounded-2xl bg-surface px-3 py-2.5 shadow-card">
            <span className="flex items-center gap-1.5 text-[10.5px] font-medium text-muted">
              <SignalDot pulse />
              Waiting for your answer
            </span>
            <span className="font-medium leading-snug">
              Give up after 3 retries, or keep trying for a minute?
            </span>
            <div className="grid gap-1.5">
              <span className="rounded-xl bg-default px-2 py-1.5 text-center font-medium">
                3 retries
              </span>
              <span className="rounded-xl bg-default px-2 py-1.5 text-center font-medium">
                Keep trying for a minute
              </span>
            </div>
          </div>
        </div>
        <div className="mt-auto flex flex-col gap-2">
          <div className="rounded-xl bg-surface px-3 py-2 text-[11px] shadow-card">
            <div className="flex items-center gap-1.5">
              <SignalDot />
              <span className="min-w-0 flex-1 truncate">
                Waiting for you · 2 of 4
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
          <div className="flex flex-col gap-2 rounded-2xl bg-surface px-3 pb-2 pt-2.5 text-[11px] shadow-card">
            <span className="text-muted">Add to the queue…</span>
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
