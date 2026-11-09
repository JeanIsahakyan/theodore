/**
 * Files in a chat: images, PDFs, anything. The 📎 button, a paste or a
 * drop adds them to the box; each is saved by the core (`save_attachment`)
 * and goes with the next message, which keeps them (`ChatMessage.
 * attachments`). The agent reads them from disk.
 *
 * Each one is a small chip, in the box and on a sent message:
 *
 * ```text
 * image chip ── hover / keyboard focus, 300 ms ──▶ the photo in a card
 * sent image ── click ──▶ the large view
 * sent image's data ── fetched at the first of those, then cached
 * ```
 */
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { Paperclip, Picture, Xmark } from '@gravity-ui/icons';
import { Button, Spinner, Tooltip } from '@heroui/react';
import { api } from '../core/api';
import type { Attachment } from '../gen/contract';
import {
  HoverCard,
  useHoverIntent,
  type HoverIntent,
} from './FileHoverPreview';
import { FileTypeIcon } from './FileTypeIcon';

/** A file on its way into the box. */
export type Pending = {
  key: string;
  name: string;
  mime: string;
  /** An object URL while the box holds an image. */
  preview: string | null;
  saved: Attachment | null;
  error: string | null;
};

export type Attachments = {
  items: Pending[];
  add: (files: FileList | File[]) => void;
  /** Already saved by the caller (e.g. `@terminal`'s tail) — straight into
   *  the strip, no upload round trip. */
  addSaved: (a: Attachment) => void;
  remove: (key: string) => void;
  clear: () => void;
  /** Saved ones' ids, for the request. */
  ids: string[];
  /** Saved ones, for the message shown before the core echoes it. */
  saved: Attachment[];
  /** Still saving: hold the send. */
  busy: boolean;
};

const MAX = 25 * 1024 * 1024;

function base64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const url = String(r.result);
      resolve(url.slice(url.indexOf(',') + 1));
    };
    r.onerror = () => reject(r.error ?? new Error('read failed'));
    r.readAsDataURL(file);
  });
}

let seq = 0;

export function useAttachments(): Attachments {
  const [items, setItems] = useState<Pending[]>([]);
  const live = useRef(items);
  useEffect(() => {
    live.current = items;
  }, [items]);
  // Object URLs go when the box does.
  useEffect(
    () => () => {
      for (const p of live.current)
        if (p.preview) URL.revokeObjectURL(p.preview);
    },
    [],
  );

  const patch = (key: string, next: Partial<Pending>) =>
    setItems((list) =>
      list.map((p) => (p.key === key ? { ...p, ...next } : p)),
    );

  const add = (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      const key = `att-${++seq}`;
      const mime = file.type || 'application/octet-stream';
      const preview = mime.startsWith('image/')
        ? URL.createObjectURL(file)
        : null;
      const name =
        file.name || (mime.startsWith('image/') ? 'image.png' : 'file');
      setItems((list) => [
        ...list,
        { key, name, mime, preview, saved: null, error: null },
      ]);
      if (file.size > MAX) {
        patch(key, { error: 'Over 25 MB' });
        continue;
      }
      void base64(file)
        .then((data) => api.saveAttachment({ name, mime, data }))
        .then((saved) => patch(key, { saved }))
        .catch((e: unknown) =>
          patch(key, { error: e instanceof Error ? e.message : 'Not saved' }),
        );
    }
  };

  const addSaved = (a: Attachment) => {
    const key = `att-${++seq}`;
    setItems((list) => [
      ...list,
      { key, name: a.name, mime: a.mime, preview: null, saved: a, error: null },
    ]);
  };

  const remove = (key: string) =>
    setItems((list) => {
      const gone = list.find((p) => p.key === key);
      if (gone?.preview) URL.revokeObjectURL(gone.preview);
      return list.filter((p) => p.key !== key);
    });

  const clear = () =>
    setItems((list) => {
      for (const p of list) if (p.preview) URL.revokeObjectURL(p.preview);
      return [];
    });

  const saved = items.flatMap((p) => (p.saved ? [p.saved] : []));
  return {
    items,
    add,
    addSaved,
    remove,
    clear,
    ids: saved.map((a) => a.id),
    saved,
    busy: items.some((p) => !p.saved && !p.error),
  };
}

/** The 📎 button: a file picker, several at once. */
export function AttachButton({
  onFiles,
  isDisabled,
}: {
  onFiles: (files: FileList) => void;
  isDisabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <Tooltip>
        <Button
          isIconOnly
          size="sm"
          variant="tertiary"
          aria-label="Attach files"
          className="attach-btn shrink-0 rounded-full"
          isDisabled={isDisabled}
          onPress={() => input.current?.click()}
        >
          <Paperclip className="size-4" />
        </Button>
        <Tooltip.Content>Attach files · or paste, or drop</Tooltip.Content>
      </Tooltip>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          if (e.currentTarget.files?.length) onFiles(e.currentTarget.files);
          e.currentTarget.value = '';
        }}
      />
    </>
  );
}

const isImage = (mime: string) => mime.startsWith('image/');

// The height of the composer's other chips (HeroUI's `sm` button).
const CHIP =
  'attachment inline-flex h-9 max-w-48 shrink-0 items-center gap-1.5 rounded-full bg-default text-xs md:h-8';

function ChipLabel({ name, mime }: { name: string; mime: string }) {
  return (
    <>
      {isImage(mime) ? (
        <Picture
          data-file-type="image"
          className="size-3.5 shrink-0 text-muted"
        />
      ) : (
        <FileTypeIcon path={name} />
      )}
      <span className="min-w-0 truncate">{name}</span>
    </>
  );
}

/** An image chip's hover: nothing for any other file. `card` goes beside the
 *  chip; `photo` runs only when it opens. */
function usePhotoHover<T extends HTMLElement>(
  image: boolean,
  name: string,
  caption: string,
  photo: () => ReactNode,
) {
  const anchor = useRef<T | null>(null);
  const { open, intent } = useHoverIntent();
  return {
    close: intent.close,
    hoverProps: image
      ? {
          ref: anchor,
          onMouseEnter: intent.enter,
          onMouseLeave: intent.leave,
          onMouseDown: intent.press,
          onMouseUp: intent.release,
        }
      : {},
    focusProps: image ? { onFocus: intent.focus, onBlur: intent.blur } : {},
    card: open ? (
      <PhotoCard anchor={anchor} intent={intent} name={name} caption={caption}>
        {photo()}
      </PhotoCard>
    ) : null,
  };
}

/** The photo at a bounded size, or why not. A checkerboard behind it, so a
 *  transparent one shows on either theme. */
function Photo({
  src,
  name,
  failed,
}: {
  src: string | null;
  name: string;
  failed?: boolean;
}) {
  const [broken, setBroken] = useState(false);
  if (failed || broken) {
    return <div className="px-3 py-3 text-xs text-muted">No preview</div>;
  }
  if (!src) {
    return (
      <div className="grid h-24 place-items-center text-muted">
        <Spinner size="sm" />
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={name}
      className="attachment-photo block max-h-[320px] max-w-[min(420px,calc(100vw-24px))] self-center object-contain"
      onError={() => setBroken(true)}
    />
  );
}

function StoredPhoto({ a }: { a: Attachment }) {
  const { url, failed } = useDataUrl(a.id);
  return <Photo src={url} name={a.name} failed={failed} />;
}

function PhotoCard<T extends HTMLElement>({
  anchor,
  intent,
  name,
  caption,
  children,
}: {
  anchor: RefObject<T | null>;
  intent: HoverIntent;
  name: string;
  caption: string;
  children: ReactNode;
}) {
  return (
    <HoverCard
      anchor={anchor}
      intent={intent}
      label={`Preview of ${name}`}
      className="attachment-hover-card w-max min-w-40 max-w-[calc(100vw-24px)]"
    >
      {children}
      {/* No width of its own: the photo sets the card's. */}
      <div className="w-0 min-w-full truncate border-t border-separator px-3 py-1.5 text-xs text-muted">
        {caption}
      </div>
    </HoverCard>
  );
}

/** One file in the box: icon, name, ×, and how its upload is going. */
export function PendingChip({
  p,
  onRemove,
  removeDisabled,
}: {
  p: Pending;
  onRemove: () => void;
  removeDisabled?: boolean;
}) {
  const image = isImage(p.mime);
  const failure = p.error ? `${p.name}: ${p.error}` : null;
  const hover = usePhotoHover<HTMLSpanElement>(
    image,
    p.name,
    failure ?? p.name,
    () =>
      // A file from elsewhere (`addSaved`) has no object URL.
      p.preview || !p.saved ? (
        <Photo src={p.preview} name={p.name} failed={!p.preview} />
      ) : (
        <StoredPhoto a={p.saved} />
      ),
  );
  return (
    <>
      <span
        className={`${CHIP} pe-1 ps-2.5`}
        data-kind={image ? 'image' : 'file'}
        // The card says it for an image; twice is noise.
        title={failure ?? (image ? undefined : p.name)}
        {...hover.hoverProps}
      >
        <span
          className="flex min-w-0 items-center gap-1.5 rounded-full"
          {...(image ? { role: 'img', 'aria-label': p.name, tabIndex: 0 } : {})}
          {...hover.focusProps}
        >
          <ChipLabel name={p.name} mime={p.mime} />
        </span>
        {!p.saved && !p.error && <Spinner size="sm" />}
        {p.error && <span className="shrink-0 text-danger">!</span>}
        <button
          type="button"
          aria-label={`Remove ${p.name}`}
          className="grid size-6 shrink-0 place-items-center rounded-full text-muted hover:bg-foreground/10 hover:text-foreground disabled:opacity-50"
          disabled={removeDisabled}
          onClick={onRemove}
        >
          <Xmark className="size-3" />
        </button>
      </span>
      {hover.card}
    </>
  );
}

/** What's in the box, above the text: each with ×. */
export function AttachmentStrip({ at }: { at: Attachments }) {
  if (!at.items.length) return null;
  return (
    <div className="attachment-strip flex w-full flex-wrap gap-1.5 px-3 pb-1">
      {at.items.map((p) => (
        <PendingChip key={p.key} p={p} onRemove={() => at.remove(p.key)} />
      ))}
    </div>
  );
}

interface DataUrl {
  promise: Promise<string>;
  /** Once it's in: a second look needs no wait, not even a tick's. */
  url: string | null;
}

const dataUrls = new Map<string, DataUrl>();

function loadDataUrl(id: string): DataUrl {
  const cached = dataUrls.get(id);
  if (cached) return cached;
  const entry: DataUrl = { promise: api.attachmentData(id), url: null };
  dataUrls.set(id, entry);
  entry.promise.then(
    (url) => {
      entry.url = url;
    },
    () => dataUrls.delete(id),
  );
  return entry;
}

/** Fetches on mount, so mount it only once the image is wanted: a long chat
 *  stays cheap. Its parent is keyed by the attachment. */
function useDataUrl(id: string): { url: string | null; failed: boolean } {
  const [url, setUrl] = useState(() => dataUrls.get(id)?.url ?? null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    loadDataUrl(id).promise.then(
      (next) => {
        if (live) setUrl(next);
      },
      () => {
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [id]);
  return { url, failed };
}

/** Portalled: a chat row is transformed, so `fixed` alone stays in the row. */
function LargeView({ a, onClose }: { a: Attachment; onClose: () => void }) {
  const { url, failed } = useDataUrl(a.id);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return createPortal(
    <div
      role="dialog"
      aria-label={a.name}
      className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-8"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      {url ? (
        <img
          src={url}
          alt={a.name}
          className="max-h-[calc(100vh-4rem)] max-w-[calc(100vw-4rem)] rounded-xl object-contain"
        />
      ) : failed ? (
        <span className="text-sm text-white">No preview</span>
      ) : (
        <Spinner size="sm" />
      )}
    </div>,
    document.body,
  );
}

function SentChip({ a }: { a: Attachment }) {
  const image = isImage(a.mime);
  const hover = usePhotoHover<HTMLButtonElement>(image, a.name, a.name, () => (
    <StoredPhoto a={a} />
  ));
  const [big, setBig] = useState(false);
  if (!image) {
    return (
      <span className={`${CHIP} px-2.5`} data-kind="file" title={a.name}>
        <ChipLabel name={a.name} mime={a.mime} />
      </span>
    );
  }
  return (
    <>
      <button
        type="button"
        className={`${CHIP} px-2.5 text-start hover:bg-default-hover`}
        data-kind="image"
        aria-label={a.name}
        onClick={() => {
          // Enter has no mouse press to close the card first.
          hover.close();
          setBig(true);
        }}
        {...hover.hoverProps}
        {...hover.focusProps}
      >
        <ChipLabel name={a.name} mime={a.mime} />
      </button>
      {hover.card}
      {big && <LargeView a={a} onClose={() => setBig(false)} />}
    </>
  );
}

/** A sent message's files. */
export function MessageAttachments({
  attachments,
  align = 'start',
}: {
  attachments: Attachment[] | null | undefined;
  align?: 'start' | 'end';
}) {
  if (!attachments?.length) return null;
  return (
    <div
      className={`message-attachments flex flex-wrap gap-1.5 ${align === 'end' ? 'justify-end' : ''}`}
    >
      {attachments.map((a) => (
        <SentChip key={a.id} a={a} />
      ))}
    </div>
  );
}

/** Paste and drop onto a box: files become attachments, text stays text. */
export function fileHandlers(add: (files: File[]) => void) {
  return {
    onPaste: (e: React.ClipboardEvent) => {
      const files = Array.from(e.clipboardData.files);
      if (files.length) {
        e.preventDefault();
        add(files);
      }
    },
    onDragOver: (e: React.DragEvent) => {
      if (e.dataTransfer.types.includes('Files')) e.preventDefault();
    },
    onDrop: (e: React.DragEvent) => {
      const files = Array.from(e.dataTransfer.files);
      if (files.length) {
        e.preventDefault();
        add(files);
      }
    },
  };
}
