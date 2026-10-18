import { stripHtmlComments } from '../highlight';
/**
 * The inline comment-thread UI used under a diff line: existing review
 * threads, pending drafts, and the composer that creates new ones. Ported
 * from the prototype's `Comments.tsx`; only the data layer changes.
 *
 * Dropped vs. the prototype (no backing data or action exists for any of
 * these — not a UI choice, a contract gap):
 * - Per-comment reactions (`Comment` has no `reactions` field).
 * - Comment edit/delete and quote-reply (no `editComment`/`deleteComment`
 *   action; threads are host state — only replying to or resolving an
 *   existing thread is wired, see `actions.ts`).
 * - `@`-mention autocomplete (`MENTIONABLE` came from mock team data; no
 *   equivalent exists here).
 * - Suggestion commit / batch commit bar (`commitSuggestions`, `BatchBar`):
 *   no action turns a suggestion into a pushed commit. The composer still
 *   lets you draft a ```suggestion fence (purely textual), but nothing
 *   commits it.
 */
import { useState } from 'react';
import {
  ArrowUp,
  Check,
  CircleCheck,
  ChevronDown,
  ChevronUp,
  Plus,
} from '@gravity-ui/icons';
import {
  AvatarGroup,
  Button,
  Card,
  Chip,
  Kbd,
  Tabs,
  TextArea,
} from '@heroui/react';
import { observer } from 'mobx-react-lite';
import { Md } from '../highlight';
import type { Anchor, Comment, Draft, PrId } from '../gen/contract';
import {
  addDraft,
  ask,
  editDraft,
  removeDraft,
  replyThread,
  resolveThread,
} from '../actions';
import { useRootStore } from '../stores/context';
import { AgentTag, Avatar, Btn } from './bits';

export const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

function timeAgo(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Markdown, plus a GitHub-style suggestion block rendered as a diff line. */
export function Body({ text }: { text: string }) {
  const m = text.match(/^([\s\S]*?)```suggestion\n([\s\S]*?)\n```([\s\S]*)$/);
  if (!m) return <Md text={text} />;
  return (
    <div className="flex flex-col">
      {m[1]?.trim() && <Md text={m[1].trim()} />}
      <div className="suggestion my-1 overflow-hidden rounded-xl border border-separator font-mono">
        <div className="sug-h bg-surface-secondary px-2 py-0.5 font-sans text-xs text-muted">
          Suggested change
        </div>
        {m[2]!.split('\n').map((s, i) => (
          <div key={i} className="ln t-add">
            <span className="mark">+</span>
            <code className="src">{s}</code>
          </div>
        ))}
      </div>
      {m[3]?.trim() && <Md text={m[3].trim()} />}
    </div>
  );
}

/** One comment of a thread. The prototype's edit/delete/reactions menu is
 *  dropped — see file header. */
export function CommentView({ c }: { c: Comment }) {
  return (
    <div className="comment flex gap-3">
      <Avatar person={c.author} size={24} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-medium">{c.author.name ?? c.author.login}</span>
          <span className="text-xs text-muted">
            {timeAgo(c.created_at)}
            {c.edited && ' · edited'}
          </span>
        </div>
        <div className="text-sm leading-relaxed">
          <Body text={c.body} />
        </div>
      </div>
    </div>
  );
}

/** A review thread: collapsed to one line once resolved, same as the
 *  prototype; expands to the full comment list and a reply box. */
export const ThreadView = observer(function ThreadView({
  pr,
  id,
}: {
  pr: PrId;
  id: string;
}) {
  const store = useRootStore();
  const t = store.models.prDetails.get(pr)?.threads.find((th) => th.id === id);
  const [open, setOpen] = useState(() => !t?.resolved);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  if (!t) return null;
  const people = [
    ...new Map(t.comments.map((c) => [c.author.login, c.author])).values(),
  ];
  const send = () => {
    const body = text.trim();
    if (!body) return;
    setBusy(true);
    void replyThread(store, pr, id, body)
      .then(() => setText(''))
      .finally(() => setBusy(false));
  };
  if (!open)
    return (
      <Card
        variant="secondary"
        className="thread collapsed max-w-[760px] cursor-pointer flex-row items-center gap-3 px-4 py-2.5 text-sm"
        onClick={() => setOpen(true)}
      >
        <CircleCheck className="size-4 shrink-0 text-success" />
        <AvatarGroup>
          {people.map((p) => (
            <Avatar key={p.login} person={p} size={20} />
          ))}
        </AvatarGroup>
        <span className="min-w-0 flex-1 truncate text-muted">
          {t.comments[0]!.author.login}:{' '}
          {stripHtmlComments(t.comments[0]!.body)}
        </span>
        <span className="shrink-0 text-xs text-muted">
          {plural(t.comments.length, 'comment', 'comments')}
        </span>
        <ChevronDown className="size-4 shrink-0 text-muted" />
      </Card>
    );
  return (
    <Card
      className={`thread max-w-[760px] gap-0 overflow-hidden p-0 ${t.resolved ? 'resolved' : ''}`}
    >
      <div className="flex w-full items-center gap-2 border-b border-separator px-4 py-2">
        <Chip
          size="sm"
          variant="soft"
          color={t.resolved ? 'success' : 'warning'}
          className="gap-1"
        >
          {t.resolved && <CircleCheck className="size-3.5" />}
          {t.resolved ? 'Resolved' : 'Open'}
        </Chip>
        <span className="text-xs text-muted">
          {plural(t.comments.length, 'comment', 'comments')}
        </span>
        <span className="flex-1" />
        <Button
          size="sm"
          variant="ghost"
          className="gap-1.5"
          onPress={() => void resolveThread(store, pr, id, !t.resolved)}
        >
          <Check className="size-3.5" />
          {t.resolved ? 'Unresolve' : 'Resolve'}
        </Button>
        {t.resolved && (
          <Button
            isIconOnly
            size="sm"
            variant="ghost"
            aria-label="Collapse"
            onPress={() => setOpen(false)}
          >
            <ChevronUp className="size-4" />
          </Button>
        )}
      </div>
      <div className="flex flex-col gap-4 px-4 py-3">
        {t.comments.map((c, i) => (
          <CommentView key={c.id ?? i} c={c} />
        ))}
      </div>
      <div className="flex items-center gap-1.5 border-t border-separator px-3 py-2">
        <TextArea
          aria-label="Reply"
          rows={1}
          fullWidth
          value={text}
          placeholder="Reply…"
          className="font-sans text-xs"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim()) {
              send();
            }
          }}
        />
        <Button
          isIconOnly
          size="sm"
          aria-label="Send reply"
          isPending={busy}
          isDisabled={!text.trim()}
          onPress={send}
        >
          <ArrowUp className="size-4" />
        </Button>
      </div>
    </Card>
  );
});

/** A not-yet-submitted comment, held locally until "Submit review". */
export function DraftView({ d }: { d: Draft }) {
  const store = useRootStore();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(d.body);
  const label =
    d.anchor.start_line != null
      ? `${d.anchor.start_line}–${d.anchor.line}`
      : `${d.anchor.line}`;
  return (
    <Card className="draft max-w-[760px] gap-2 border border-warning/40 px-4 py-3">
      <div className="flex items-center gap-1.5 text-xs text-muted">
        <Chip size="sm" variant="soft" color="warning">
          pending
        </Chip>
        draft{d.source.kind === 'agent' && <AgentTag id={d.source.agent} />}
        <span className="tabular-nums">· lines {label}</span>
        <span className="flex-1" />
        {editing ? (
          <Button
            size="sm"
            variant="ghost"
            onPress={() => {
              editDraft(store, d.id, text);
              setEditing(false);
            }}
          >
            save
          </Button>
        ) : (
          <Button size="sm" variant="ghost" onPress={() => setEditing(true)}>
            edit
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          onPress={() => removeDraft(store, d.id)}
        >
          delete
        </Button>
      </div>
      {editing ? (
        <TextArea
          fullWidth
          aria-label="draft"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
        />
      ) : (
        <Body text={d.body} />
      )}
    </Card>
  );
}

/** Composer for a new draft, anchored to one line or a shift-click range. */
export function Composer({
  pr,
  anchor,
  lineText,
  onClose,
}: {
  pr: PrId;
  anchor: Anchor;
  lineText: string;
  onClose: () => void;
}) {
  const store = useRootStore();
  const [text, setText] = useState('');
  const [preview, setPreview] = useState(false);
  const submit = () => {
    const body = text.trim();
    if (!body) return;
    addDraft(store, pr, anchor, body);
    onClose();
  };
  return (
    <Card className="composer max-w-[760px] gap-1.5 p-2">
      <div className="flex items-center gap-2 px-1 text-xs text-muted">
        <Tabs
          data-plain
          selectedKey={preview ? 'preview' : 'write'}
          onSelectionChange={(k) => setPreview(k === 'preview')}
          className="w-fit"
        >
          <Tabs.ListContainer>
            <Tabs.List aria-label="Comment" className="composer-tabs">
              <Tabs.Tab id="write" className="h-6 px-2.5 text-xs">
                Write
                <Tabs.Indicator />
              </Tabs.Tab>
              <Tabs.Tab id="preview" className="h-6 px-2.5 text-xs">
                <Tabs.Separator />
                Preview
                <Tabs.Indicator />
              </Tabs.Tab>
            </Tabs.List>
          </Tabs.ListContainer>
        </Tabs>
        <span className="composer-range font-medium text-foreground">
          {anchor.start_line != null ? 'Lines' : 'Line'}{' '}
          {anchor.start_line != null
            ? `${anchor.start_line}–${anchor.line}`
            : anchor.line}
        </span>
        <span>
          <Kbd className="text-[10px]">⇧</Kbd> + click{' '}
          <Plus className="inline size-3" /> on another line —{' '}
          {anchor.start_line != null ? 'extend' : 'range'}
        </span>
      </div>
      {preview ? (
        <div className="composer-preview min-h-[76px] rounded-xl border border-separator px-3 py-2 text-sm">
          {text.trim() ? (
            <Body text={text} />
          ) : (
            <span className="text-muted">Nothing to preview</span>
          )}
        </div>
      ) : (
        <TextArea
          autoFocus
          fullWidth
          rows={3}
          aria-label="comment"
          value={text}
          placeholder="Comment… markdown, ⌘⏎ to add to review"
          className="font-mono text-xs"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
            if (e.key === 'Escape') onClose();
          }}
        />
      )}
      <div className="flex items-center gap-1.5">
        <Button
          size="sm"
          variant="ghost"
          onPress={() =>
            setText(
              (t) =>
                `${t}${t ? '\n' : ''}\`\`\`suggestion\n${lineText}\n\`\`\``,
            )
          }
        >
          Suggestion
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onPress={() =>
            void ask(store, {
              pr,
              question: text.trim() || 'explain this line',
              about: anchor,
              group: null,
              agent: null,
            }).catch(() => {})
          }
        >
          Ask AI
        </Button>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onPress={onClose}>
          Cancel
        </Button>
        <Btn tone="primary" kbd="⌘⏎" isDisabled={!text.trim()} onPress={submit}>
          Add to review
        </Btn>
      </div>
    </Card>
  );
}
