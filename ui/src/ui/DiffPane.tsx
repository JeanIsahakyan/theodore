import { useState } from 'react';
import {
  ArrowUp,
  Check,
  CircleCheck,
  Eye,
  FileCode,
  Plus,
} from '@gravity-ui/icons';
import { Button, Card, Chip, TextArea } from '@heroui/react';
import { observer } from 'mobx-react-lite';
import { Code, langOf, rich } from '../highlight';
import type {
  Anchor,
  DiffLine,
  FileDiff,
  Hunk,
  PrId,
  Revision,
  Side,
} from '../gen/contract';
import { addDraft, markGroupRead, setFileViewed } from '../actions';
import { useRootStore } from '../stores/context';
import { Btn } from './bits';
import type { ReviewMode } from './GroupsPane';

function lineAnchor(
  rev: Revision['head'],
  path: string,
  l: DiffLine,
): Anchor | null {
  if (l.kind === 'del') {
    if (l.old_no == null) return null;
    return {
      rev,
      path,
      side: 'old',
      line: l.old_no,
      start_line: null,
      start_side: null,
    };
  }
  if (l.new_no == null) return null;
  return {
    rev,
    path,
    side: 'new',
    line: l.new_no,
    start_line: null,
    start_side: null,
  };
}

const sameAnchor = (a: Anchor, path: string, side: Side, line: number) =>
  a.path === path && a.side === side && a.line === line;

export const DiffPane = observer(function DiffPane({
  pr,
  rev,
  mode,
}: {
  pr: PrId;
  rev: Revision;
  mode: ReviewMode;
}) {
  const store = useRootStore();
  const [composer, setComposer] = useState<{
    path: string;
    side: Side;
    line: number;
  } | null>(null);

  const groupHunkIds =
    mode.mode === 'groups' && mode.group
      ? new Set(store.models.groups.get(mode.group)?.hunks ?? [])
      : null;
  const files: FileDiff[] =
    mode.mode === 'files'
      ? rev.files.filter((f) => f.path === mode.file)
      : groupHunkIds
        ? rev.files
            .map((f) => ({
              ...f,
              hunks: f.hunks.filter((h) => groupHunkIds.has(h.id)),
            }))
            .filter((f) => f.hunks.length)
        : rev.files;

  return (
    <main className="diff min-w-0 overflow-auto bg-background px-6 pb-20 pt-5">
      {mode.mode === 'groups' && mode.group && (
        <GroupCard pr={pr} groupId={mode.group} />
      )}
      {files.map((f) => (
        <FileBlock
          key={f.path}
          pr={pr}
          rev={rev.head}
          file={f}
          composer={composer}
          setComposer={setComposer}
        />
      ))}
    </main>
  );
});

const GroupCard = observer(function GroupCard({
  pr,
  groupId,
}: {
  pr: PrId;
  groupId: string;
}) {
  const store = useRootStore();
  const g = store.models.groups.get(groupId);
  if (!g) return null;
  const read = store.models.hunkReads
    .where((r) => r.pr === pr)
    .map((r) => r.hunk);
  const allRead = g.hunks.every((h) => read.includes(h));
  return (
    <Card className="gcard mb-5 gap-4 p-5">
      <div className="flex items-center gap-3">
        <Chip size="sm" variant="secondary">
          {g.kind}
        </Chip>
        <span className="text-base font-semibold">{g.title}</span>
        <span className="flex-1" />
        <Btn
          tone={allRead ? 'ghost' : 'tertiary'}
          icon={<Check />}
          className={allRead ? 'text-success' : ''}
          isDisabled={allRead}
          onPress={() => markGroupRead(store, pr, g.hunks)}
        >
          {allRead ? 'Read' : 'Mark as read'}
        </Btn>
      </div>
      <p className="rich flex max-w-[78ch] gap-2 text-sm leading-relaxed">
        {rich(g.why)}
      </p>
      {g.check.length > 0 && (
        <div className="flex flex-col gap-1.5 rounded-2xl bg-surface-secondary px-4 py-3 text-sm">
          <span className="text-xs text-muted">What to check</span>
          {g.check.map((c) => (
            <span key={c}>{c}</span>
          ))}
        </div>
      )}
    </Card>
  );
});

function FileBlock({
  pr,
  rev,
  file,
  composer,
  setComposer,
}: {
  pr: PrId;
  rev: Revision['head'];
  file: FileDiff;
  composer: { path: string; side: Side; line: number } | null;
  setComposer: (c: { path: string; side: Side; line: number } | null) => void;
}) {
  const store = useRootStore();
  const lang = langOf(file.path);
  const viewed = store.models.fileViews
    .where((v) => v.pr === pr && v.path === file.path)
    .at(-1);
  const isViewed = viewed?.state === 'viewed';
  if (file.flags.some((f) => f.kind === 'oversize' || f.kind === 'binary')) {
    return (
      <Card className="file mb-4 gap-0 overflow-hidden p-4 text-sm text-muted">
        {file.path}: not shown ({file.flags.map((f) => f.kind).join(', ')})
      </Card>
    );
  }
  return (
    <Card className="file mb-4 gap-0 overflow-hidden p-0">
      <header className="file-h sticky top-0 z-[2] flex items-center gap-3 border-b border-separator bg-surface px-4 py-2.5 text-sm">
        <FileCode className="size-4 shrink-0 text-muted" />
        <span className="min-w-0 truncate font-mono text-[13px] font-medium">
          {file.path}
        </span>
        {file.status === 'added' && (
          <Chip size="sm" variant="soft" color="success">
            new file
          </Chip>
        )}
        {file.status === 'deleted' && (
          <Chip size="sm" variant="soft" color="danger">
            deleted
          </Chip>
        )}
        <span className="shrink-0 whitespace-nowrap text-xs tabular-nums">
          <span className="text-success">+{file.additions}</span>{' '}
          <span className="text-danger">−{file.deletions}</span>
        </span>
        <span className="flex-1" />
        <Button
          size="sm"
          variant={isViewed ? 'secondary' : 'tertiary'}
          className="viewed-toggle gap-1.5"
          onPress={() => setFileViewed(store, pr, file.path, !isViewed)}
        >
          {isViewed ? (
            <CircleCheck className="size-4 text-success" />
          ) : (
            <Eye className="size-4" />
          )}
          Viewed
        </Button>
      </header>
      {file.hunks.map((h) => (
        <HunkView
          key={h.id}
          pr={pr}
          rev={rev}
          path={file.path}
          h={h}
          lang={lang}
          composer={composer}
          setComposer={setComposer}
        />
      ))}
    </Card>
  );
}

function HunkView({
  pr,
  rev,
  path,
  h,
  lang,
  composer,
  setComposer,
}: {
  pr: PrId;
  rev: Revision['head'];
  path: string;
  h: Hunk;
  lang: ReturnType<typeof langOf>;
  composer: { path: string; side: Side; line: number } | null;
  setComposer: (c: { path: string; side: Side; line: number } | null) => void;
}) {
  const store = useRootStore();
  const read =
    store.models.hunkReads.where((r) => r.pr === pr && r.hunk === h.id).length >
    0;
  return (
    <div
      className={`hunk border-t border-separator first:border-t-0 ${read ? 'read' : ''}`}
    >
      <div className="flex min-h-8 items-center gap-3 px-4 py-1 text-xs text-muted bg-surface-secondary">
        <span className="tabular-nums">
          {h.header ||
            `@@ -${h.old_start},${h.old_lines} +${h.new_start},${h.new_lines} @@`}
        </span>
        <span className="flex-1" />
        {read && (
          <span className="inline-flex items-center gap-1 text-success">
            <Check className="size-3.5" /> read
          </span>
        )}
      </div>
      <div className="lines">
        {h.lines.map((l, i) => (
          <Line
            key={i}
            pr={pr}
            rev={rev}
            path={path}
            l={l}
            lang={lang}
            composer={composer}
            setComposer={setComposer}
          />
        ))}
      </div>
    </div>
  );
}

const Line = observer(function Line({
  pr,
  rev,
  path,
  l,
  lang,
  composer,
  setComposer,
}: {
  pr: PrId;
  rev: Revision['head'];
  path: string;
  l: DiffLine;
  lang: ReturnType<typeof langOf>;
  composer: { path: string; side: Side; line: number } | null;
  setComposer: (c: { path: string; side: Side; line: number } | null) => void;
}) {
  const store = useRootStore();
  const anchor = lineAnchor(rev, path, l);
  const threads = anchor
    ? store.models.threads.where(
        (t) =>
          !!t.anchor && sameAnchor(t.anchor, path, anchor.side, anchor.line),
      )
    : [];
  const drafts = anchor
    ? store.models.drafts.where((d) =>
        sameAnchor(d.anchor, path, anchor.side, anchor.line),
      )
    : [];
  const composing =
    anchor &&
    composer &&
    sameAnchor(anchor, path, composer.side, composer.line);
  return (
    <>
      <div className={`ln t-${l.kind}`}>
        <span className="no">{l.old_no ?? ''}</span>
        <span className="no">{l.new_no ?? ''}</span>
        <span className="mark">
          {l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}
        </span>
        <Code s={l.text} lang={lang} />
        <span className="ln-act">
          {anchor && (
            <Button
              isIconOnly
              size="sm"
              aria-label="comment"
              className="h-5 min-w-5 w-5 rounded-xl text-xs"
              onPress={() =>
                setComposer({ path, side: anchor.side, line: anchor.line })
              }
            >
              <Plus className="size-3" />
            </Button>
          )}
        </span>
      </div>
      {(threads.length > 0 || drafts.length > 0 || composing) && (
        <div className="flex flex-col gap-2 border-y border-separator bg-background py-2 pl-[108px] pr-3 font-sans text-sm">
          {threads.map((t) => (
            <ThreadView key={t.id} id={t.id} />
          ))}
          {drafts.map((d) => (
            <div
              key={d.id}
              className="draft max-w-[760px] gap-2 rounded-2xl border border-warning/40 px-4 py-3"
            >
              <div className="text-xs text-muted">pending draft</div>
              <div className="text-sm">{d.body}</div>
            </div>
          ))}
          {composing && anchor && (
            <Composer
              pr={pr}
              anchor={anchor}
              onClose={() => setComposer(null)}
            />
          )}
        </div>
      )}
    </>
  );
});

const ThreadView = observer(function ThreadView({ id }: { id: string }) {
  const store = useRootStore();
  const t = store.models.threads.get(id);
  if (!t) return null;
  return (
    <Card
      className={`thread max-w-[760px] gap-0 overflow-hidden p-0 ${t.resolved ? 'resolved' : ''}`}
    >
      <div className="flex items-center gap-2 border-b border-separator px-4 py-2">
        <Chip
          size="sm"
          variant="soft"
          color={t.resolved ? 'success' : 'warning'}
        >
          {t.resolved ? 'Resolved' : 'Open'}
        </Chip>
        <span className="text-xs text-muted">{t.comments.length} comments</span>
      </div>
      <div className="flex flex-col gap-3 px-4 py-3">
        {t.comments.map((c, i) => (
          <div key={c.id ?? i} className="flex flex-col gap-0.5 text-sm">
            <span className="font-medium">{c.author.login}</span>
            <span>{c.body}</span>
          </div>
        ))}
      </div>
    </Card>
  );
});

function Composer({
  pr,
  anchor,
  onClose,
}: {
  pr: PrId;
  anchor: Anchor;
  onClose: () => void;
}) {
  const store = useRootStore();
  const [text, setText] = useState('');
  return (
    <Card className="composer max-w-[760px] gap-1.5 p-2">
      <TextArea
        autoFocus
        fullWidth
        rows={3}
        aria-label="comment"
        value={text}
        placeholder="Comment… ⌘⏎ to add to review"
        className="font-mono text-xs"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim()) {
            addDraft(store, pr, anchor, text.trim());
            onClose();
          }
          if (e.key === 'Escape') onClose();
        }}
      />
      <div className="flex items-center gap-1.5">
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onPress={onClose}>
          Cancel
        </Button>
        <Btn
          tone="primary"
          icon={<ArrowUp />}
          isDisabled={!text.trim()}
          onPress={() => {
            addDraft(store, pr, anchor, text.trim());
            onClose();
          }}
        >
          Add to review
        </Btn>
      </div>
    </Card>
  );
}
