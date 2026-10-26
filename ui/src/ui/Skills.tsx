/**
 * Skills: `SkillsManagerModal` (opened from "Manage skills…" in the chat's
 * `/` list) and the standalone `SkillsPage` — a list + SKILL.md editor
 * (open via `get_skill`, save via `save_skill`). Running a skill lives in
 * the chat's `/` list.
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
import { Copy, FloppyDisk, ListCheck, Plus, Sparkles } from '@gravity-ui/icons';
import {
  Alert,
  Button,
  Header,
  InputGroup,
  Label,
  ListBox,
  Modal,
  TextArea,
  TextField,
  Typography,
} from '@heroui/react';
import { observer } from 'mobx-react-lite';
import type { PrId, SkillBody, SkillInfo } from '../gen/contract';
import { getSkill, saveSkill } from '../actions';
import { api } from '../core/api';
import { useRootStore } from '../stores/context';
import { Empty, Shell, Spinner } from './bits';
import { ViewHeader } from './List';

/** Id rule for a new skill, enforced client-side before `save_skill` ever
 *  sees it (the command itself has its own server-side check). */
export const SKILL_ID_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/;

const SKILL_TEMPLATE = (id: string) => `---
name: ${id}
description: TODO — one line on when an agent should reach for this skill.
---

# ${id}

TODO: instructions for the agent.
`;

const SOURCES: {
  id: string;
  title: string;
  match: (s: SkillInfo) => boolean;
}[] = [
  { id: 'repo', title: 'Repository', match: (s) => s.source.includes('·') },
  {
    id: 'user',
    title: 'Mine',
    match: (s) => s.source === '~/.claude/skills',
  },
  { id: 'builtin', title: 'Built-in', match: (s) => s.source === 'built-in' },
];

// ── skills editor: open a skill, edit SKILL.md, save or fork ────────────

const SOURCE_FILTER: {
  id: string;
  title: string;
  match: (s: SkillInfo) => boolean;
}[] = SOURCES;

/** Open a skill via `get_skill`, edit its SKILL.md, save to "My skills"
 *  (`~/.claude/skills`) or "This repo" (`.claude/skills` in the PR's repo)
 *  via `save_skill`. Built-ins are read-only — fork a copy instead. */
export const SkillEditorPanel = observer(function SkillEditorPanel({
  id,
  pr,
  onSaved,
}: {
  id: string;
  pr: PrId | null;
  /** After a save or fork lands: the list re-reads (a fork adds a row). */
  onSaved?: () => void;
}) {
  const store = useRootStore();
  const [body, setBody] = useState<SkillBody | null>(null);
  // Bumped after a fork: re-read the skill, now your editable copy.
  const [version, setVersion] = useState(0);
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
  }, [store, id, pr, version]);

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
        if (!ok) return;
        setBody((b) => (b ? { ...b, body: draft } : b));
        onSaved?.();
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
    })
      .then((ok) => {
        if (!ok) return;
        onSaved?.();
        setVersion((v) => v + 1);
      })
      .finally(() => setSaving(null));
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

  const [listVersion, setListVersion] = useState(0);
  useEffect(() => {
    void api
      .listSkills(pr)
      .then((s) => {
        setSkills(s);
        setSel((cur) => cur ?? s[0]?.id ?? null);
      })
      .catch(() => setSkills([]));
  }, [pr, listVersion]);

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
                        className="w-full min-w-0 flex-col items-start gap-0.5 px-3 py-2"
                      >
                        <span className="w-full truncate font-mono text-sm">
                          /{k.id}
                        </span>
                        <span className="w-full truncate text-xs text-muted">
                          {k.description}
                        </span>
                      </ListBox.Item>
                    ))}
                  </ListBox.Section>
                );
              })}
            </ListBox>
            {sel ? (
              <SkillEditorPanel
                key={sel}
                id={sel}
                pr={pr}
                onSaved={() => setListVersion((v) => v + 1)}
              />
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

// ── standalone Skills page: `G K` / sidebar, not scoped to any one PR ───────

/** `id` plus a starter template, saved via `save_skill` at user scope —
 *  the only scope that makes sense with no PR open to pick a repo from. */
const NewSkillModal = observer(function NewSkillModal({
  onCreated,
  onClose,
}: {
  onCreated: (id: string) => void;
  onClose: () => void;
}) {
  const store = useRootStore();
  const [id, setId] = useState('');
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);
  const trimmed = id.trim();
  const idError =
    trimmed.length === 0
      ? null
      : SKILL_ID_RE.test(trimmed)
        ? null
        : 'Lowercase letters, digits, "_", "-" or "." only — must start with a letter, digit, "_" or "-".';

  const create = () => {
    if (!trimmed || idError) return;
    setSaving(true);
    void saveSkill(store, {
      id: trimmed,
      scope: 'user',
      pr: null,
      body: body.trim() || SKILL_TEMPLATE(trimmed),
    })
      .then((ok) => {
        if (ok) onCreated(trimmed);
      })
      .finally(() => setSaving(false));
  };

  return (
    <Shell
      title="New skill"
      onClose={onClose}
      footer={
        <>
          <Button variant="tertiary" onPress={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            isDisabled={!trimmed || !!idError}
            isPending={saving}
            onPress={create}
          >
            Create
          </Button>
        </>
      }
    >
      <TextField value={id} onChange={setId} isInvalid={!!idError} autoFocus>
        <Label className="text-sm font-medium">Id</Label>
        <InputGroup className="rounded-xl">
          <InputGroup.Prefix className="text-muted">/</InputGroup.Prefix>
          <InputGroup.Input
            placeholder="my-skill"
            className="font-mono text-sm"
            onKeyDown={(e) => e.key === 'Enter' && create()}
          />
        </InputGroup>
        {idError && <span className="text-xs text-danger">{idError}</span>}
      </TextField>
      <div className="flex flex-col gap-1.5">
        <Label className="text-sm font-medium">
          SKILL.md{' '}
          <span className="text-muted">
            (optional — a template is used if left blank)
          </span>
        </Label>
        <TextArea
          rows={8}
          aria-label="SKILL.md"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={SKILL_TEMPLATE(trimmed || 'my-skill')}
          className="skill-body font-mono text-xs leading-5"
        />
      </div>
    </Shell>
  );
});

/** The standalone skills library: every skill from every source, filterable,
 *  opened in the same editor as the in-review `SkillsManagerModal`. Unlike
 *  that modal this isn't scoped to a PR, so "Save to this repo" never appears
 *  here (`SkillEditorPanel` already hides it when `pr` is `null`). */
export const SkillsPage = observer(function SkillsPage() {
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);

  const reload = () => {
    void api
      .listSkills(null)
      .then((s) => {
        setSkills(s);
        setSel((cur) => cur ?? s[0]?.id ?? null);
      })
      .catch(() => setSkills([]));
  };
  useEffect(reload, []);

  const query = q.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      !skills
        ? []
        : query
          ? skills.filter(
              (s) =>
                s.id.toLowerCase().includes(query) ||
                s.title.toLowerCase().includes(query) ||
                s.description.toLowerCase().includes(query),
            )
          : skills,
    [skills, query],
  );

  return (
    <div className="view skills-page flex min-w-0 flex-1 flex-col">
      <ViewHeader title="Skills" count={skills?.length}>
        <TextField aria-label="Search skills" value={q} onChange={setQ}>
          <InputGroup className="w-56 rounded-2xl">
            <InputGroup.Input placeholder="Search skills…" />
          </InputGroup>
        </TextField>
        <Button
          size="sm"
          variant="primary"
          className="new-skill gap-1.5"
          onPress={() => setCreating(true)}
        >
          <Plus className="size-4" />
          New skill
        </Button>
      </ViewHeader>
      <div className="grid min-h-0 flex-1 grid-cols-[260px_minmax(0,1fr)]">
        {!skills ? (
          <div className="flex items-center gap-2 p-6 text-sm text-muted">
            <Spinner /> Loading…
          </div>
        ) : (
          <ListBox
            aria-label="Skills"
            selectionMode="single"
            selectedKeys={sel ? [sel] : []}
            onSelectionChange={(keys) => {
              const v = keys === 'all' ? undefined : [...keys][0];
              if (v) setSel(String(v));
            }}
            className="skill-list min-h-0 overflow-auto border-r border-separator px-2 py-3"
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
                  <Header className="px-3 pb-1.5 pt-3 text-xs text-muted">
                    {src.title}
                  </Header>
                  {items.map((k) => (
                    <ListBox.Item
                      key={k.id}
                      id={k.id}
                      textValue={k.title}
                      className="w-full min-w-0 flex-col items-start gap-0.5 px-3 py-2"
                    >
                      <span className="w-full truncate font-mono text-sm">
                        /{k.id}
                      </span>
                      <span className="w-full truncate text-xs text-muted">
                        {k.description}
                      </span>
                    </ListBox.Item>
                  ))}
                </ListBox.Section>
              );
            })}
          </ListBox>
        )}
        {sel ? (
          <SkillEditorPanel key={sel} id={sel} pr={null} onSaved={reload} />
        ) : (
          <Empty
            icon={<Sparkles />}
            title="No skills yet"
            text="Create one, or wait for repos and built-ins to load."
          />
        )}
      </div>
      {creating && (
        <NewSkillModal
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            reload();
            setSel(id);
          }}
        />
      )}
    </div>
  );
});
