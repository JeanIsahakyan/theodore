/**
 * Spaces (docs/spaces.md), hidden behind build mode: the space page (chat
 * with the agent on the left, the live diff vs base on the right), the
 * New space dialog, Settings → Labs, and the "turn done" notices.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  Archive,
  CircleStop,
  CodePullRequest,
  PaperPlane,
} from '@gravity-ui/icons';
import {
  Alert,
  Button,
  Card,
  Input,
  Label,
  ListBox,
  Select,
  Switch,
  TextArea,
  TextField,
  Tooltip,
  Typography,
} from '@heroui/react';
import { observer } from 'mobx-react-lite';
import type { HunkId, Space } from '../../gen/contract';
import { api } from '../../core/api';
import { ALL } from '../../core/workspaces';
import { FEATURES } from '../../features';
import { setSetting } from '../../actions';

import { useRootStore, useUi } from '../../stores/context';
import { AgentTag, Shell, Spinner } from '../bits';
import { DiffPane, type ComposerState } from '../DiffPane';
import type { ReviewMode } from '../GroupsPane';
import { fmtUsage } from '../SidePanel';
import { isBuildMode } from './mode';
import { markSpaceSeen } from './seen';
import { BUILD_MODE_KEY, diffStat, spaceChatKey } from './spaces';

/** The whole branch diff, ungrouped — every file of the revision. */
const WHOLE_DIFF: ReviewMode = { mode: 'groups', group: null, file: null };

export const SpacePage = observer(function SpacePage({ id }: { id: string }) {
  const store = useRootStore();
  const space = store.models.spaces.get(id);

  useEffect(() => {
    void store.sync.openPr(spaceChatKey(id));
  }, [store, id]);

  // Open the live diff without grouping before anything asks for its
  // revision (a cold `get_revision` would open it grouped).
  const [opened, setOpened] = useState(false);
  const live = space && space.status !== 'archived';
  useEffect(() => {
    if (!live) return;
    let on = true;
    api
      .spaceReview({ space: id, group: false })
      .then(() => on && setOpened(true))
      .catch(() => {});
    return () => {
      on = false;
    };
  }, [id, live]);

  useEffect(() => {
    if (space) markSpaceSeen(id, space.updated_at);
  }, [id, space, space?.updated_at]);

  if (!space) {
    return (
      <div className="view grid flex-1 place-items-center text-muted">
        This space no longer exists.
      </div>
    );
  }
  return (
    <div className="view space-page flex min-w-0 flex-1 flex-col">
      <SpaceHeader space={space} />
      <div className="flex min-h-0 flex-1">
        <section className="flex w-[40%] min-w-[340px] flex-col border-r border-separator">
          <SpaceChat space={space} />
        </section>
        <section className="flex min-w-0 flex-1 flex-col">
          {opened || !live ? (
            <SpaceChanges space={space} />
          ) : (
            <div className="grid flex-1 place-items-center text-muted">
              <Spinner />
            </div>
          )}
        </section>
      </div>
      {space.status === 'archived' && (
        <Alert status="accent" className="m-3">
          <Alert.Content>
            <Alert.Description>
              Archived. The transcript and the checkpoint ref are kept.
            </Alert.Description>
          </Alert.Content>
        </Alert>
      )}
    </div>
  );
});

const SpaceHeader = observer(function SpaceHeader({ space }: { space: Space }) {
  const store = useRootStore();
  const ui = useUi();
  const [busy, setBusy] = useState(false);
  const running = space.status === 'running';
  return (
    <header className="flex flex-wrap items-center gap-2 border-b border-separator px-5 py-3">
      <Typography.Heading level={6} className="min-w-0 truncate">
        {space.name}
      </Typography.Heading>
      <span className="truncate font-mono text-xs text-muted">
        {space.branch} ← {space.base}
      </span>
      <span className="rounded-full bg-default px-2 py-0.5 text-xs">
        Drafting
      </span>
      <AgentTag id={space.agent} />
      <span className="text-xs tabular-nums text-muted">
        {fmtUsage(space.usage)}
      </span>
      <span className="flex-1" />
      <Button
        size="sm"
        variant="secondary"
        isDisabled={busy || space.status === 'archived'}
        onPress={async () => {
          setBusy(true);
          try {
            const res = await api.spaceReview({ space: space.id, group: true });
            await store.sync.openPr(res.pr);
            ui.go({ name: 'review', pr: res.pr });
          } catch {
            // toasted by api.ts
          } finally {
            setBusy(false);
          }
        }}
      >
        Review
      </Button>
      <Tooltip>
        <Button size="sm" variant="secondary" isDisabled aria-label="Open PR">
          <CodePullRequest className="size-3.5" />
          Open PR
        </Button>
        <Tooltip.Content>
          Not in this build yet (docs/spaces.md §11)
        </Tooltip.Content>
      </Tooltip>
      <Tooltip>
        <Button
          isIconOnly
          size="sm"
          variant="ghost"
          aria-label="Archive space"
          isDisabled={running || space.status === 'archived'}
          onPress={() => {
            void api
              .archiveSpace(space.id)
              .then(() => ui.goBack())
              .catch(() => {});
          }}
        >
          <Archive className="size-4" />
        </Button>
        <Tooltip.Content>
          Archive (keeps the transcript and checkpoints)
        </Tooltip.Content>
      </Tooltip>
    </header>
  );
});

const SpaceChat = observer(function SpaceChat({ space }: { space: Space }) {
  const store = useRootStore();
  const [text, setText] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const messages = [
    ...store.models.chatMessages.byPr(spaceChatKey(space.id)),
  ].sort((a, b) => a.at - b.at);
  const run = space.status === 'running' ? space.run : null;
  const streaming = run ? store.ephemeral.agentText.get(run) : undefined;
  const tools = run ? (store.ephemeral.runLog.get(run) ?? []) : [];
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end' });
  }, [messages.length, streaming]);

  const send = () => {
    const t = text.trim();
    if (!t || run || space.status === 'archived') return;
    setText('');
    void api
      .spaceSend({
        space: space.id,
        text: t,
        agent: null,
        model: null,
        mode: null,
      })
      .catch(() => setText(t));
  };

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-5 py-4">
        {messages.length === 0 && !run && (
          <span className="text-sm text-muted">
            Tell the agent what to change. It works in its own worktree; your
            checkout is never touched.
          </span>
        )}
        {messages.map((m) => (
          <div key={m.id} className="flex flex-col gap-1">
            <span className="text-xs text-muted">
              {m.author.kind === 'me' ? 'you' : m.author.agent}
              {m.usage && m.author.kind === 'agent'
                ? ` · ${fmtUsage(m.usage)}`
                : ''}
            </span>
            {m.failed ? (
              <span className="text-sm text-danger">{m.failed}</span>
            ) : (
              <div className="whitespace-pre-wrap text-sm leading-relaxed">
                {m.text}
              </div>
            )}
          </div>
        ))}
        {run && (
          <div className="flex flex-col gap-1">
            <span className="flex items-center gap-2 text-xs text-muted">
              <Spinner /> {space.agent} is working
              {tools.length ? ` · ${tools.length} tool calls` : ''}
            </span>
            {streaming && (
              <div className="whitespace-pre-wrap text-sm leading-relaxed">
                {streaming}
              </div>
            )}
          </div>
        )}
        <div ref={end} />
      </div>
      <div className="flex flex-col gap-2 border-t border-separator px-4 py-3">
        <TextArea
          rows={2}
          fullWidth
          aria-label="Message the agent"
          placeholder={
            space.status === 'archived'
              ? 'Archived'
              : 'Ask the agent to change something…'
          }
          value={text}
          disabled={space.status === 'archived'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="flex items-center gap-2">
          {space.status === 'failed' && space.error && (
            <span
              className="min-w-0 flex-1 truncate text-xs text-danger"
              title={space.error}
            >
              {space.error}
            </span>
          )}
          <span className="flex-1" />
          {run ? (
            <Button
              size="sm"
              variant="secondary"
              onPress={() => void api.spaceStop(space.id).catch(() => {})}
            >
              <CircleStop className="size-3.5" />
              Stop
            </Button>
          ) : (
            <Button
              size="sm"
              isDisabled={!text.trim() || space.status === 'archived'}
              onPress={send}
            >
              <PaperPlane className="size-3.5" />
              Send
            </Button>
          )}
        </div>
      </div>
    </>
  );
});

const SpaceChanges = observer(function SpaceChanges({
  space,
}: {
  space: Space;
}) {
  const store = useRootStore();
  const review = space.review_pr;
  const summary = review ? store.models.prSummaries.get(review) : undefined;
  const revision =
    review && summary
      ? store.revisions.get(`${review}@${summary.head_sha}`, () =>
          api.getRevision({ pr: review, head: summary.head_sha }),
        )
      : null;
  const [focusHunk, setFocusHunk] = useState<HunkId | null>(null);
  const [composer, setComposer] = useState<ComposerState | null>(null);
  const setMode = useMemo(() => () => {}, []);
  const rev = revision?.status === 'ready' ? revision.data : null;
  return (
    <>
      <div className="flex items-center gap-3 border-b border-separator px-5 py-2.5 text-xs text-muted">
        <span className="tabular-nums text-foreground">
          {rev ? diffStat(rev.files) : '…'}
        </span>
        <span>
          vs {space.base} ·{' '}
          {space.turns ? `after turn ${space.turns}` : 'no turns yet'}
        </span>
        {space.status === 'running' && (
          <span>· refreshes when the turn ends</span>
        )}
      </div>
      {!review || !summary || !revision ? (
        <div className="grid flex-1 place-items-center text-muted">
          No changes yet.
        </div>
      ) : revision.status === 'error' ? (
        <div className="grid flex-1 place-items-center text-danger">
          Could not load the diff.
        </div>
      ) : !rev ? (
        <div className="grid flex-1 place-items-center text-muted">
          <Spinner />
        </div>
      ) : rev.files.length === 0 ? (
        <div className="grid flex-1 place-items-center text-muted">
          No changes yet.
        </div>
      ) : (
        <DiffPane
          pr={review}
          rev={rev}
          mode={WHOLE_DIFF}
          setMode={setMode}
          focusHunk={focusHunk}
          setFocusHunk={setFocusHunk}
          composer={composer}
          setComposer={setComposer}
        />
      )}
    </>
  );
});

/** New space: project, goal, optional name. Start creates the worktree and
 *  sends the goal as the first turn. */
export const NewSpaceModal = observer(function NewSpaceModal() {
  const store = useRootStore();
  const ui = useUi();
  const ready = store.models.projects.where((p) => p.status === 'ready');
  const [project, setProject] = useState<string | null>(
    ui.workspace !== ALL ? ui.workspace : (ready[0]?.id ?? null),
  );
  const [goal, setGoal] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const start = async () => {
    if (!project || !goal.trim()) return;
    setBusy(true);
    try {
      const s = await api.createSpace({
        project,
        goal: goal.trim(),
        name: name.trim() || null,
        branch: null,
        base: null,
        agent: null,
        model: null,
      });
      ui.closeModal();
      ui.go({ name: 'space', id: s.id });
    } catch {
      // toasted by api.ts
    } finally {
      setBusy(false);
    }
  };
  return (
    <Shell
      title="New space"
      onClose={() => ui.closeModal()}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onPress={() => ui.closeModal()}>
            Cancel
          </Button>
          <Button
            isDisabled={!project || !goal.trim()}
            isPending={busy}
            onPress={() => void start()}
          >
            Start
          </Button>
        </div>
      }
    >
      {ui.workspace === ALL && (
        <Select
          aria-label="Project"
          value={project}
          onChange={(v) => setProject(v ? String(v) : null)}
        >
          <Label>Project</Label>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox selectionMode="single">
              {ready.map((p) => (
                <ListBox.Item key={p.id} id={p.id} textValue={p.repo.name}>
                  {p.repo.name}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
      )}
      <TextArea
        rows={3}
        fullWidth
        autoFocus
        aria-label="What should change?"
        placeholder="What should change?"
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
      />
      <TextField value={name} onChange={setName}>
        <Label>Name (optional, from the goal)</Label>
        <Input placeholder="retry-export-429" className="font-mono text-sm" />
      </TextField>
    </Shell>
  );
});

/** Settings → Labs: the build mode switch. */
export const LabsPage = observer(function LabsPage() {
  const store = useRootStore();
  const on = isBuildMode(store);
  return (
    <section className="flex flex-col gap-2">
      <Typography.Heading level={6}>Spaces</Typography.Heading>
      <Card className="flex flex-row items-center gap-3 px-4 py-3">
        <Switch
          size="sm"
          aria-label="Spaces"
          isSelected={on}
          isDisabled={FEATURES.buildMode}
          onChange={(v) => setSetting(store, 'user', BUILD_MODE_KEY, v)}
        >
          <Switch.Content>
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
          </Switch.Content>
        </Switch>
        <span className="text-sm">
          An agent writes a change in its own worktree; you review it before it
          becomes a pull request. Experimental.
        </span>
      </Card>
    </section>
  );
});
