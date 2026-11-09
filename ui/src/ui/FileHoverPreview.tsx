/**
 * A file named in a chat, hovered: its diff for that turn if it changed,
 * otherwise a look at it. Nothing is fetched or mounted until a chip is
 * actually hovered, and the popover portals out, so a row never changes size.
 *
 * ```text
 * hover / keyboard focus ── 300 ms ──▶ popover, fetched now (cached by file + revision)
 * off the chip ──▶ into the popover     stays open: scroll, select
 * off both ── 120 ms ──▶ closed         Escape: closed at once
 * another chip while one is open ── 60 ms ──▶ swapped, no gap
 * ```
 */
import {
  createContext,
  memo,
  use,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { Popover } from 'react-aria-components';
import { popoverVariants } from '@heroui/styles';
import { api } from '../core/api';
import type {
  FileDiff,
  FilePreview,
  FilePreviewAnswer,
  FilePreviewRequest,
  PreviewGap,
  PreviewSource,
} from '../gen/contract';
import {
  Code,
  hunkLineTokens,
  langOf,
  Md,
  tokenizeLines,
  useShikiVersion,
  type Lang,
} from '../highlight';
import { Spinner } from './bits';
import { wordMarks } from './diff';
import { FileTypeIcon } from './FileTypeIcon';
import { formatBytes } from './media/imageDiff';

const OPEN_DELAY = 300;
/** Another popover is open: its reader is already looking at files. */
const SWITCH_DELAY = 60;
/** Long enough to cross the gap between the chip and the popover. */
const CLOSE_DELAY = 120;
/** How long an answer about a worktree that can still change is trusted. */
const UNPINNED_TTL = 3000;
const CACHE_LIMIT = 40;

/** What a chip fetches and the cache files it under. */
export interface FilePreviewTarget {
  source: PreviewSource;
  /** What a key adds for the answer to hold: a reply's or a commit's id. */
  revision: string | null;
}

const TargetContext = createContext<FilePreviewTarget | null>(null);

/** Tells the chips under it which turn of which space they're in. */
export function FilePreviewScope({
  space,
  reply,
  children,
}: {
  space: string;
  /** `null`: the turn still running. */
  reply: string | null;
  children: ReactNode;
}) {
  const target = useMemo<FilePreviewTarget>(
    () => ({ source: { kind: 'space', space, reply }, revision: reply }),
    [space, reply],
  );
  return <TargetContext value={target}>{children}</TargetContext>;
}

// ── cache ───────────────────────────────────────────────────────────────────

interface Cached {
  answer: FilePreviewAnswer;
  at: number;
}

const cache = new Map<string, Cached>();
const inFlight = new Map<string, Promise<FilePreviewAnswer>>();

/** For a test to start from nothing. */
export function clearFilePreviewCache() {
  cache.clear();
  inFlight.clear();
}

const previewKey = (target: FilePreviewTarget, path: string) =>
  JSON.stringify([target.source, target.revision, path]);

function cachedPreview(key: string): FilePreviewAnswer | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (!hit.answer.pinned && Date.now() - hit.at > UNPINNED_TTL) {
    cache.delete(key);
    return null;
  }
  return hit.answer;
}

function loadPreview(
  key: string,
  req: FilePreviewRequest,
): Promise<FilePreviewAnswer> {
  const fresh = cachedPreview(key);
  if (fresh) {
    // Touched last: eviction takes the oldest.
    cache.delete(key);
    cache.set(key, { answer: fresh, at: Date.now() });
    return Promise.resolve(fresh);
  }
  const running = inFlight.get(key);
  if (running) return running;
  const load = api.filePreview(req, true).then(
    (answer) => {
      inFlight.delete(key);
      cache.set(key, { answer, at: Date.now() });
      if (cache.size > CACHE_LIMIT)
        cache.delete(cache.keys().next().value as string);
      return answer;
    },
    (e: unknown) => {
      inFlight.delete(key);
      throw e;
    },
  );
  inFlight.set(key, load);
  return load;
}

// ── hover ───────────────────────────────────────────────────────────────────

/** What closes the open popover: one at a time, across the whole app. */
let shown: (() => void) | null = null;
type Timer = ReturnType<typeof setTimeout>;

/** One chip's hover timing. No React: chips are many, hovers are few. */
class HoverIntent {
  private opening: Timer | null = null;
  private closing: Timer | null = null;
  private overCard = false;
  /** A click focuses the chip too; that's no keyboard focus. */
  private pressed = false;

  constructor(private readonly setOpen: (open: boolean) => void) {}

  private stopTimers() {
    if (this.opening) clearTimeout(this.opening);
    if (this.closing) clearTimeout(this.closing);
    this.opening = null;
    this.closing = null;
  }

  enter = () => {
    if (this.closing) clearTimeout(this.closing);
    this.closing = null;
    if (shown === this.close || this.opening) return;
    this.opening = setTimeout(
      () => {
        this.opening = null;
        shown?.();
        shown = this.close;
        this.setOpen(true);
      },
      shown ? SWITCH_DELAY : OPEN_DELAY,
    );
  };

  leave = () => {
    if (this.opening) clearTimeout(this.opening);
    this.opening = null;
    if (shown === this.close && !this.overCard && !this.closing)
      this.closing = setTimeout(this.close, CLOSE_DELAY);
  };

  enterCard = () => {
    this.overCard = true;
    window.removeEventListener('mouseup', this.leaveCard);
    if (this.closing) clearTimeout(this.closing);
    this.closing = null;
  };

  leaveCard = () => {
    this.overCard = false;
    this.leave();
  };

  /** A selection dragged past the card's edge isn't leaving it. */
  leaveCardUnlessSelecting = (e: { buttons: number }) => {
    if (e.buttons === 0) {
      this.leaveCard();
      return;
    }
    window.addEventListener('mouseup', this.leaveCard, { once: true });
  };

  focus = () => {
    if (!this.pressed) this.enter();
  };

  blur = () => {
    this.pressed = false;
    this.leave();
  };

  /** The chip is being clicked: it does its own thing, this gets out of the way. */
  press = () => {
    this.pressed = true;
    this.close();
  };

  release = () => {
    this.pressed = false;
  };

  close = () => {
    this.stopTimers();
    this.overCard = false;
    window.removeEventListener('mouseup', this.leaveCard);
    if (shown === this.close) shown = null;
    this.setOpen(false);
  };

  dispose = () => {
    this.stopTimers();
    window.removeEventListener('mouseup', this.leaveCard);
    if (shown === this.close) shown = null;
  };
}

export interface FileHover<T extends HTMLElement> {
  /** There's something to preview: the chip shouldn't also carry a `title`. */
  active: boolean;
  triggerProps: {
    ref?: RefObject<T | null>;
    onMouseEnter?: () => void;
    onMouseLeave?: () => void;
    onMouseDown?: () => void;
    onMouseUp?: () => void;
    onFocus?: () => void;
    onBlur?: () => void;
  };
  /** Render beside the chip, not inside it: it portals anyway. */
  popover: ReactNode;
}

/** The hover behaviour for a chip naming `path`; `null`: not a file. Without
 *  a `resolve`, the target is the surrounding `FilePreviewScope`'s; `resolve`
 *  runs when it opens, so what it reads is what's true then. */
export function useFileHover<T extends HTMLElement = HTMLElement>(
  path: string | null,
  resolve?: () => FilePreviewTarget | null,
): FileHover<T> {
  const scoped = use(TargetContext);
  const anchor = useRef<T | null>(null);
  const [open, setOpen] = useState(false);
  const [intent] = useState(() => new HoverIntent(setOpen));
  useEffect(() => intent.dispose, [intent]);

  const active = path != null && (resolve != null || scoped != null);
  const triggerProps = useMemo(
    () =>
      active
        ? {
            ref: anchor,
            onMouseEnter: intent.enter,
            onMouseLeave: intent.leave,
            onMouseDown: intent.press,
            onMouseUp: intent.release,
            onFocus: intent.focus,
            onBlur: intent.blur,
          }
        : {},
    [active, intent],
  );

  const target = open ? (resolve ? resolve() : scoped) : null;
  const popover =
    open && target && path != null ? (
      <PreviewPopover
        anchor={anchor}
        path={path}
        target={target}
        intent={intent}
      />
    ) : null;
  return { active, triggerProps, popover };
}

// ── the popover ─────────────────────────────────────────────────────────────

/** React events bubble out of a portal, to whatever the chip sits in. */
const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

function PreviewPopover<T extends HTMLElement>({
  anchor,
  path,
  target,
  intent,
}: {
  anchor: RefObject<T | null>;
  path: string;
  target: FilePreviewTarget;
  intent: HoverIntent;
}) {
  useEffect(() => {
    // Capture: the Escape is this popover's, not the chat's or the composer's.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      intent.close();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [intent]);
  return (
    <Popover
      triggerRef={anchor}
      isOpen
      isNonModal
      placement="top start"
      offset={8}
      onOpenChange={(next) => {
        if (!next) intent.close();
      }}
      className={popoverVariants().base({
        className:
          // `animate-none`: moving between chips swaps the card, it doesn't pop.
          'file-hover-card flex w-[560px] max-w-[calc(100vw-24px)] animate-none flex-col overflow-hidden rounded-xl p-0',
      })}
    >
      <div
        role="group"
        aria-label={`Preview of ${path}`}
        className="flex min-h-0 flex-col"
        onMouseEnter={intent.enterCard}
        onMouseLeave={intent.leaveCardUnlessSelecting}
        onClick={stop}
        onMouseDown={stop}
        onPointerDown={stop}
        onKeyDown={stop}
      >
        <PreviewCard path={path} target={target} />
      </div>
    </Popover>
  );
}

type Loaded = FilePreviewAnswer | 'failed';

function usePreview(
  target: FilePreviewTarget,
  path: string,
): { key: string; value: Loaded | null } {
  const key = previewKey(target, path);
  const req = useMemo(
    () => ({ source: target.source, path }),
    [target.source, path],
  );
  const [got, setGot] = useState<{ key: string; value: Loaded } | null>(null);
  useEffect(() => {
    let live = true;
    loadPreview(key, req).then(
      (value) => {
        if (live) setGot({ key, value });
      },
      () => {
        if (live) setGot({ key, value: 'failed' });
      },
    );
    return () => {
      live = false;
    };
  }, [key, req]);
  // The answer's own key: a chip reused for another file shows no old answer.
  return { key, value: got?.key === key ? got.value : cachedPreview(key) };
}

function PreviewCard({
  path,
  target,
}: {
  path: string;
  target: FilePreviewTarget;
}) {
  const { value } = usePreview(target, path);
  const answer = value === 'failed' ? null : value;
  return (
    <>
      <div className="flex min-w-0 items-center gap-1.5 border-b border-separator px-3 py-1.5">
        <FileTypeIcon path={path} />
        <span
          className="min-w-0 flex-1 truncate font-mono text-xs"
          title={path}
        >
          {path}
        </span>
        {answer && !answer.pinned && (
          <span
            className="shrink-0 text-[11px] text-muted"
            title="The worktree as it is now"
          >
            Current
          </span>
        )}
        {answer && <Stat preview={answer.preview} />}
      </div>
      <div className="min-h-0 max-h-[340px] overflow-auto overscroll-contain">
        {value == null ? (
          <div className="flex h-16 items-center justify-center text-muted">
            <Spinner />
          </div>
        ) : value === 'failed' ? (
          <Gap path={path} text="No preview" />
        ) : (
          <Body preview={value.preview} path={path} />
        )}
      </div>
    </>
  );
}

function Stat({ preview }: { preview: FilePreview }) {
  if (preview.kind === 'diff') {
    return (
      <span className="shrink-0 font-mono text-[11px]">
        <span className="text-success">+{preview.file.additions}</span>{' '}
        <span className="text-danger">−{preview.file.deletions}</span>
      </span>
    );
  }
  if (preview.kind === 'text' || preview.kind === 'image') {
    return (
      <span className="shrink-0 text-[11px] text-muted">
        {formatBytes(Number(preview.bytes))}
      </span>
    );
  }
  return null;
}

const GAP_TEXT: Record<PreviewGap, string> = {
  missing: 'No preview',
  binary: 'Binary file',
  too_large: 'Too large to preview',
};

function Gap({ path, text }: { path: string; text: string }) {
  return (
    <div className="file-hover-gap flex items-center gap-2 px-3 py-3 text-xs text-muted">
      <span className="min-w-0 truncate font-mono">
        {path.split('/').pop()}
      </span>
      <span className="shrink-0">{text}</span>
    </div>
  );
}

function Body({ preview, path }: { preview: FilePreview; path: string }) {
  switch (preview.kind) {
    case 'diff':
      return (
        <>
          <DiffLines file={preview.file} lang={langOf(path)} />
          <MoreLines count={preview.more_lines} />
        </>
      );
    case 'image':
      return <ImagePreview preview={preview} path={path} />;
    case 'text':
      return <TextBody preview={preview} path={path} />;
    case 'unavailable':
      return (
        <Gap
          path={path}
          text={
            preview.bytes != null
              ? `${GAP_TEXT[preview.reason]} · ${formatBytes(Number(preview.bytes))}`
              : GAP_TEXT[preview.reason]
          }
        />
      );
  }
}

function MoreLines({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <div className="file-hover-more px-3 py-1.5 text-xs text-muted">
      {count} more {count === 1 ? 'line' : 'lines'}
    </div>
  );
}

function ImagePreview({
  preview,
  path,
}: {
  preview: Extract<FilePreview, { kind: 'image' }>;
  path: string;
}) {
  const [broken, setBroken] = useState(false);
  if (broken) return <Gap path={path} text="No preview" />;
  return (
    <div className="flex justify-center p-3">
      {/* An <img> even for SVG: scripts in a data: image never run. */}
      <img
        alt={path}
        src={`data:${preview.mime};base64,${preview.base64}`}
        className="max-h-[300px] max-w-full object-contain"
        onError={() => setBroken(true)}
      />
    </div>
  );
}

function TextBody({
  preview,
  path,
}: {
  preview: Extract<FilePreview, { kind: 'text' }>;
  path: string;
}) {
  if (!preview.text) return <Gap path={path} text="Empty file" />;
  const lang = langOf(path);
  return (
    <>
      {lang === 'markdown' ? (
        <div className="file-hover-md px-3 py-2 text-sm">
          <Md text={preview.text} />
        </div>
      ) : (
        <TextLines text={preview.text} lang={lang} />
      )}
      <MoreLines count={preview.more_lines} />
      {preview.cut && (
        <div className="file-hover-cut px-3 py-1.5 text-xs text-muted">
          The file goes on · {formatBytes(Number(preview.bytes))} in all
        </div>
      )}
    </>
  );
}

const TEXT_COLUMNS = { gridTemplateColumns: '40px minmax(0, 1fr)' };
const DIFF_COLUMNS = { gridTemplateColumns: '40px 16px minmax(0, 1fr)' };
const SIGN = { add: '+', del: '−', ctx: ' ' } as const;

const TextLines = memo(function TextLines({
  text,
  lang,
}: {
  text: string;
  lang: Lang;
}) {
  const shikiVersion = useShikiVersion();
  const toks = useMemo(
    () => tokenizeLines(text, lang),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- shikiVersion forces a recompute once Shiki/the grammar finishes loading; it isn't read inside
    [text, lang, shikiVersion],
  );
  const lines = useMemo(() => text.split('\n'), [text]);
  return (
    <div className="lines file-hover-text py-1">
      {lines.map((line, i) => (
        <div key={i} className="ln" style={TEXT_COLUMNS}>
          <span className="no">{i + 1}</span>
          <Code s={line} lang={lang} toks={toks[i]} />
        </div>
      ))}
    </div>
  );
});

const DiffLines = memo(function DiffLines({
  file,
  lang,
}: {
  file: FileDiff;
  lang: Lang;
}) {
  const shikiVersion = useShikiVersion();
  const rows = useMemo(
    () =>
      file.hunks.map((h) => ({
        h,
        toks: hunkLineTokens(h.lines, lang),
        marks: wordMarks(h.lines),
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- shikiVersion forces a recompute once Shiki/the grammar finishes loading; it isn't read inside
    [file, lang, shikiVersion],
  );
  return (
    <div className="lines file-hover-diff">
      {rows.map(({ h, toks, marks }, hi) => (
        <div key={h.id}>
          {hi > 0 && <div className="h-px bg-separator" />}
          {h.lines.map((l, i) => (
            <div key={i} className={`ln t-${l.kind}`} style={DIFF_COLUMNS}>
              <span className="no">
                {(l.kind === 'del' ? l.old_no : l.new_no) ?? ''}
              </span>
              <span className="mark">{SIGN[l.kind]}</span>
              <Code
                s={l.text}
                lang={lang}
                marks={marks.get(i)}
                toks={toks[i]}
              />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
});
