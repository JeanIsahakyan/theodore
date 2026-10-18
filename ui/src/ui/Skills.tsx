/**
 * A richer picker for skills than the inline `/` autocomplete in `Chat`:
 * search every skill by where it lives (repo, user, built-in), read its
 * description, pick which agents run it, then fire it on the open PR.
 * "Manage…" opens `SkillsManagerModal`, a list + SKILL.md editor (open via
 * `get_skill`, save via `save_skill`), ported from the prototype's
 * `Skills.tsx` settings page.
 *
 * The prototype's editor also had a "who can run what" matrix and a
 * per-skill `agents` field; `SkillInfo` carries neither, and there's no
 * command to set one — that part stays dropped.
 *
 * `save_skill` needs a `pr` to resolve which repo's `.claude/skills` to
 * write to for `scope: 'repo'` — there's no such thing as a repo-scoped
 * save outside an open PR, so "Save to this repo" only appears when a `pr`
 * is given (i.e. opened from a review, not from a PR-less context).
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Copy,
  FloppyDisk,
  ListCheck,
  Pencil,
  Play,
  Sparkles,
} from '@gravity-ui/icons';
import {
  Alert,
  Button,
  Header,
  InputGroup,
  ListBox,
  Modal,
  Popover,
  TextArea,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@heroui/react';
import { observer } from 'mobx-react-lite';
import type { AgentId, PrId, SkillBody, SkillInfo } from '../gen/contract';
import { getSkill, saveSkill } from '../actions';
import { api } from '../core/api';
import { useRootStore } from '../stores/context';
import { Empty, Spinner } from './bits';

const AGENTS: AgentId[] = ['claude', 'codex', 'gemini'];

const SOURCES: {
  id: string;
  title: string;
  match: (s: SkillInfo) => boolean;
}[] = [
  { id: 'repo', title: 'Repository', match: (s) => s.source.includes('·') },
  {
    id: 'user',
    title: 'Mine · ~/.claude/skills',
    match: (s) => s.source === '~/.claude/skills',
  },
  { id: 'builtin', title: 'Built-in', match: (s) => s.source === 'built-in' },
];

/** Browse every skill available to this PR and run one, on the agents you pick. */
export function SkillBrowser({
  pr,
  skills,
  agents,
  onRun,
}: {
  pr: PrId | null;
  skills: SkillInfo[];
  agents: AgentId[];
  onRun: (skill: SkillInfo, agents: AgentId[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [managing, setManaging] = useState(false);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<AgentId[]>(agents);
  const query = q.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      query
        ? skills.filter(
            (s) =>
              s.id.toLowerCase().includes(query) ||
              s.title.toLowerCase().includes(query) ||
              s.description.toLowerCase().includes(query),
          )
        : skills,
    [skills, query],
  );
  const run = (s: SkillInfo) => {
    onRun(s, picked.length ? picked : agents);
    setOpen(false);
    setQ('');
  };
  return (
    <Popover isOpen={open} onOpenChange={setOpen}>
      <Tooltip>
        <Button
          isIconOnly
          size="sm"
          variant="tertiary"
          aria-label="Browse skills"
          className="browse-skills rounded-full"
        >
          <Play className="size-4" />
        </Button>
        <Tooltip.Content>Browse skills</Tooltip.Content>
      </Tooltip>
      <Popover.Content placement="top start" className="w-96">
        <Popover.Dialog className="flex max-h-[60vh] flex-col gap-2 p-2">
          <TextField
            aria-label="Search skills"
            value={q}
            onChange={setQ}
            autoFocus
          >
            <InputGroup fullWidth className="rounded-2xl">
              <InputGroup.Input placeholder="Search skills…" />
            </InputGroup>
          </TextField>
          <ToggleButtonGroup
            size="sm"
            selectionMode="multiple"
            selectedKeys={new Set(picked)}
            onSelectionChange={(keys) =>
              setPicked(AGENTS.filter((a) => keys.has(a)))
            }
            aria-label="Agents to run on"
            className="px-1"
          >
            {AGENTS.map((a, i) => (
              <ToggleButton key={a} id={a} className="font-mono text-xs">
                {i > 0 && <ToggleButtonGroup.Separator />}
                {a}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
          <ListBox
            aria-label="Skills"
            selectionMode="none"
            onAction={(k) => {
              const s = skills.find((x) => x.id === String(k));
              if (s) run(s);
            }}
            className="min-h-0 flex-1 overflow-auto p-0"
            renderEmptyState={() => (
              <Empty
                icon={<ListCheck />}
                title="No skills"
                text="Nothing matches."
              />
            )}
          >
            {SOURCES.map((src) => {
              const items = filtered.filter(src.match);
              if (!items.length) return null;
              return (
                <ListBox.Section key={src.id} id={src.id}>
                  <Header className="px-2 pb-1 pt-2 text-xs text-muted">
                    {src.title}
                  </Header>
                  {items.map((s) => (
                    <ListBox.Item
                      key={s.id}
                      id={s.id}
                      textValue={s.title}
                      className="flex-col items-start gap-0.5 rounded-xl px-3 py-2"
                    >
                      <span className="flex w-full items-center gap-2">
                        <span className="font-mono text-sm">/{s.id}</span>
                        <span className="ms-auto text-xs text-muted">
                          {s.source}
                        </span>
                      </span>
                      <span className="truncate text-xs text-muted">
                        {s.description}
                      </span>
                    </ListBox.Item>
                  ))}
                </ListBox.Section>
              );
            })}
          </ListBox>
          <Button
            size="sm"
            variant="ghost"
            className="manage-skills justify-start gap-1.5 text-muted"
            onPress={() => {
              setOpen(false);
              setManaging(true);
            }}
          >
            <Pencil className="size-3.5" />
            Manage skills…
          </Button>
        </Popover.Dialog>
      </Popover.Content>
      {managing && (
        <SkillsManagerModal pr={pr} onClose={() => setManaging(false)} />
      )}
    </Popover>
  );
}

// ── skills editor: open a skill, edit SKILL.md, save or fork ────────────

const SOURCE_FILTER: {
  id: string;
  title: string;
  match: (s: SkillInfo) => boolean;
}[] = SOURCES;

/** Open a skill via `get_skill`, edit its SKILL.md, save to "My skills"
 *  (`~/.claude/skills`) or "This repo" (`.claude/skills` in the PR's repo)
 *  via `save_skill`. Built-ins are read-only — fork a copy instead. */
const SkillEditorPanel = observer(function SkillEditorPanel({
  id,
  pr,
}: {
  id: string;
  pr: PrId | null;
}) {
  const store = useRootStore();
  const [body, setBody] = useState<SkillBody | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState<'user' | 'repo' | null>(null);

  useEffect(() => {
    let live = true;
    setBody(null);
    void getSkill(store, id, pr).then((b) => {
      if (!live) return;
      setBody(b);
      setDraft(b?.body ?? '');
    });
    return () => {
      live = false;
    };
  }, [store, id, pr]);

  if (!body) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-muted">
        <Spinner /> Loading…
      </div>
    );
  }

  const dirty = draft !== body.body;
  const readOnly = !body.editable;

  const save = (scope: 'user' | 'repo') => {
    setSaving(scope);
    void saveSkill(store, { id: body.info.id, scope, pr, body: draft })
      .then((ok) => {
        if (ok) setBody((b) => (b ? { ...b, body: draft } : b));
      })
      .finally(() => setSaving(null));
  };

  const fork = () => {
    setSaving('user');
    void saveSkill(store, {
      id: body.info.id,
      scope: 'user',
      pr: null,
      body: draft,
    }).finally(() => setSaving(null));
  };

  return (
    <div className="skill-editor flex min-w-0 flex-1 flex-col gap-3 overflow-auto p-4">
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col">
          <Typography.Heading level={5} className="font-mono">
            /{body.info.id}
          </Typography.Heading>
          <span className="truncate text-xs text-muted">
            {body.info.source}
          </span>
        </div>
        {readOnly ? (
          <Button
            size="sm"
            className="fork-skill gap-1.5"
            isPending={saving === 'user'}
            onPress={fork}
          >
            <Copy className="size-4" />
            Fork to my skills
          </Button>
        ) : (
          <>
            <Button
              size="sm"
              variant="primary"
              className="save-skill-user gap-1.5"
              isDisabled={!dirty}
              isPending={saving === 'user'}
              onPress={() => save('user')}
            >
              <FloppyDisk className="size-4" />
              Save to My skills
            </Button>
            {pr && (
              <Button
                size="sm"
                variant="secondary"
                className="save-skill-repo gap-1.5"
                isDisabled={!dirty}
                isPending={saving === 'repo'}
                onPress={() => save('repo')}
              >
                <FloppyDisk className="size-4" />
                Save to this repo
              </Button>
            )}
          </>
        )}
      </div>
      {readOnly && (
        <Alert status="default">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>
              Built-in skills are read-only. Fork a copy to edit it.
            </Alert.Description>
          </Alert.Content>
        </Alert>
      )}
      <TextArea
        rows={20}
        aria-label="SKILL.md"
        value={draft}
        readOnly={readOnly}
        onChange={(e) => setDraft(e.target.value)}
        className="skill-body font-mono text-xs leading-5"
      />
    </div>
  );
});

/** Every skill available to `pr` (or just `~/.claude/skills` and built-ins,
 *  with `pr: null`), a list to pick one from, and its editor. */
export const SkillsManagerModal = observer(function SkillsManagerModal({
  pr,
  onClose,
}: {
  pr: PrId | null;
  onClose: () => void;
}) {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [sel, setSel] = useState<string | null>(null);

  useEffect(() => {
    void api
      .listSkills(pr)
      .then((s) => {
        setSkills(s);
        setSel((cur) => cur ?? s[0]?.id ?? null);
      })
      .catch(() => setSkills([]));
  }, [pr]);

  return (
    <Modal.Backdrop isOpen onOpenChange={(open) => !open && onClose()}>
      <Modal.Container
        size="lg"
        placement="top"
        scroll="inside"
        className="mt-[8vh]"
      >
        <Modal.Dialog className="modal skills-manager flex h-[70vh] w-[860px] max-w-[92vw] flex-col gap-0 p-0">
          <Modal.CloseTrigger />
          <Modal.Header className="modal-h px-4 py-3">
            <Modal.Heading>Skills</Modal.Heading>
          </Modal.Header>
          <div className="grid min-h-0 flex-1 grid-cols-[240px_minmax(0,1fr)]">
            <ListBox
              aria-label="Skills"
              selectionMode="single"
              selectedKeys={sel ? [sel] : []}
              onSelectionChange={(keys) => {
                const v = keys === 'all' ? undefined : [...keys][0];
                if (v) setSel(String(v));
              }}
              className="skill-list overflow-auto border-r border-separator px-2 py-3"
            >
              {SOURCE_FILTER.map((src) => {
                const items = skills.filter(src.match);
                if (!items.length) return null;
                return (
                  <ListBox.Section key={src.id} id={src.id}>
                    <Header className="px-3 pb-1.5 pt-3 text-xs text-muted">
                      {src.title}
                    </Header>
                    {items.map((k) => (
                      <ListBox.Item
                        key={k.id}
                        id={k.id}
                        textValue={k.title}
                        className="flex-col items-start gap-0.5 px-3 py-2"
                      >
                        <span className="font-mono text-sm">/{k.id}</span>
                        <span className="truncate text-xs text-muted">
                          {k.description}
                        </span>
                      </ListBox.Item>
                    ))}
                  </ListBox.Section>
                );
              })}
            </ListBox>
            {sel ? (
              <SkillEditorPanel key={sel} id={sel} pr={pr} />
            ) : (
              <Empty
                icon={<Sparkles />}
                title="No skills"
                text="Nothing to edit yet."
              />
            )}
          </div>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
});
