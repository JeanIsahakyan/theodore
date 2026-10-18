/**
 * A richer picker for skills than the inline `/` autocomplete in `Chat`:
 * search every skill by where it lives (repo, user, built-in), read its
 * description, pick which agents run it, then fire it on the open PR.
 *
 * The prototype's `Skills.tsx` was a whole settings page: a list, a
 * SKILL.md editor (new/save/fork) and a "who can run what" matrix, backed
 * by a `Skill` type with a `body` and a per-skill `agents` field. Our
 * `SkillInfo` (`id`, `title`, `description`, `source`) has neither field,
 * and there's no `save_skill` / `new_skill` / `fork_skill` / `run_skill_on`
 * command — so editing, forking and the matrix aren't ported: there's
 * nothing backing them, not even a flag to gate them behind. What's real is
 * the list and running a skill on chosen agents, so that's what this is.
 */
import { useMemo, useState } from 'react';
import { ListCheck, Play } from '@gravity-ui/icons';
import {
  Button,
  Header,
  InputGroup,
  ListBox,
  Popover,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
} from '@heroui/react';
import type { AgentId, SkillInfo } from '../gen/contract';
import { Empty } from './bits';

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
  skills,
  agents,
  onRun,
}: {
  skills: SkillInfo[];
  agents: AgentId[];
  onRun: (skill: SkillInfo, agents: AgentId[]) => void;
}) {
  const [open, setOpen] = useState(false);
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
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  );
}
