/**
 * Settings → Spaces → Global config: the global config file (open it in the
 * editor), with a pointer to each project's own settings. `EffectiveConfigView`
 * is a project's merged config read-only — which files it comes from, every
 * effective value with its layer, unknown keys, and whether the repo's
 * commands are allowed (Project settings → Spaces, the config editor's
 * preview). Also `SpaceSetupAssistHint`, the space page's "no `spaces:`
 * commands yet" nudge.
 */
import { useEffect, useState } from 'react';

import { Sparkles, TriangleExclamation, Xmark } from '@gravity-ui/icons';
import { Button, Card, Chip, Typography } from '@heroui/react';
import { observer } from 'mobx-react-lite';
import type {
  ConfigLayer,
  EffectiveConfig,
  GlobalConfigInfo,
  Space,
  SpaceConfigView,
} from '../../gen/contract';
import { api } from '../../core/api';
import { STORAGE_NS } from '../../stores/UiStore';
import { LAYER_LABEL, fileStatus, groupEntries, settingUp } from './commands';

const LAYER_COLOR: Record<ConfigLayer, 'default' | 'accent' | 'warning'> = {
  global: 'default',
  repo: 'warning',
  local: 'accent',
};

function LayerBadge({ layer }: { layer: ConfigLayer }) {
  return (
    <Chip size="sm" variant="soft" color={LAYER_COLOR[layer]}>
      {LAYER_LABEL[layer]}
    </Chip>
  );
}

const dismissedKey = (project: string) =>
  `${STORAGE_NS}theodore-setup-assist-dismissed:${project}`;

/** The space page's nudge above the composer: no `spaces:` commands are
 *  configured for this project yet, so there's nothing to run or check.
 *  "Set up with agent" sends the space's own agent a turn to look at the
 *  repo and write them (docs/config.md §2, §8); the normal trust prompt
 *  applies to whatever it proposes, same as any other repo config. Not while
 *  a turn runs or setup is on; dismissed per project. */
export const SpaceSetupAssistHint = observer(function SpaceSetupAssistHint({
  space,
  config,
}: {
  space: Pick<Space, 'id' | 'project' | 'status' | 'setup'>;
  config: Pick<SpaceConfigView, 'commands'> | null;
}) {
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem(dismissedKey(space.project)) === '1',
  );
  if (
    dismissed ||
    space.status === 'archived' ||
    space.status === 'running' ||
    settingUp(space) ||
    config == null ||
    config.commands.length > 0
  ) {
    return null;
  }
  const run = async () => {
    setBusy(true);
    try {
      await api.spaceSetupAssist(space.id);
    } catch {
      // toasted by api.ts
    } finally {
      setBusy(false);
    }
  };
  const dismiss = () => {
    localStorage.setItem(dismissedKey(space.project), '1');
    setDismissed(true);
  };
  return (
    <div className="space-setup-assist-hint flex items-center gap-2 px-2 text-xs text-muted">
      <span className="min-w-0 flex-1 truncate">
        This project has no setup, run or check commands yet.
      </span>
      <Button
        size="sm"
        variant="ghost"
        className="space-setup-assist h-6 shrink-0 px-2 text-xs"
        isPending={busy}
        onPress={() => void run()}
      >
        <Sparkles className="size-3.5" />
        Set up with agent
      </Button>
      <Button
        size="sm"
        variant="ghost"
        isIconOnly
        aria-label="Dismiss"
        className="size-5 min-w-0 shrink-0"
        onPress={dismiss}
      >
        <Xmark className="size-3" />
      </Button>
    </div>
  );
});

export const GlobalConfigSection = observer(function GlobalConfigSection() {
  const [info, setInfo] = useState<GlobalConfigInfo | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let on = true;
    api
      .globalConfig()
      .then((i) => on && setInfo(i))
      .catch(() => {});
    return () => {
      on = false;
    };
  }, []);
  const open = async () => {
    setBusy(true);
    try {
      setInfo(await api.openGlobalConfig());
    } catch {
      // toasted by api.ts
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="config-section mt-4 flex flex-col gap-2">
      <Typography.Heading level={6}>Global config</Typography.Heading>
      <Card
        variant="secondary"
        className="flex flex-row items-center gap-3 px-4 py-3"
      >
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate font-mono text-sm">
            {info?.path ?? '…'}
          </span>
          <span className="text-xs text-muted">
            {info == null
              ? 'Loading…'
              : info.exists
                ? 'Applies to every project; a repo’s own config and your local file win over it, key by key.'
                : 'Not created yet — Open in editor creates it from a commented template.'}
          </span>
        </div>
        <Button
          size="sm"
          variant="secondary"
          className="config-open shrink-0"
          isPending={busy}
          onPress={() => void open()}
        >
          Open in editor
        </Button>
      </Card>
      <span className="config-projects-hint text-xs text-muted">
        Each project’s config, as it applies: Project settings → Spaces.
      </span>
    </section>
  );
});

export function EffectiveConfigView({ config }: { config: EffectiveConfig }) {
  const repo = config.repo_commands;
  return (
    <>
      <ul className="flex flex-col gap-1">
        {config.files.map((f) => {
          const status = fileStatus(f);
          return (
            <li
              key={`${f.layer}:${f.path}`}
              className="flex min-w-0 items-center gap-2 text-xs"
            >
              <LayerBadge layer={f.layer} />
              <span
                className={`min-w-0 truncate font-mono ${f.exists ? '' : 'text-muted'}`}
                title={f.path}
              >
                {f.path}
              </span>
              {status && (
                <span
                  className={
                    f.error || f.legacy ? 'text-warning' : 'text-muted'
                  }
                >
                  {status}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {config.unknown.length > 0 && (
        <div className="flex items-start gap-2 text-xs text-warning">
          <TriangleExclamation className="mt-0.5 size-3.5 shrink-0" />
          <span>
            Unknown keys (typos, or from a newer version):{' '}
            <span className="font-mono">{config.unknown.join(', ')}</span>
          </span>
        </div>
      )}
      {repo && (
        <span className="text-xs text-muted">
          Commands from this repo ({repo.items.length}):{' '}
          {repo.trusted ? (
            <span className="text-success">allowed</span>
          ) : (
            <span className="text-warning">not allowed yet</span>
          )}
        </span>
      )}
      {config.entries.length === 0 ? (
        <span className="text-xs text-muted">No values set.</span>
      ) : (
        <div className="flex flex-col gap-2">
          {groupEntries(config.entries).map((g) => (
            <div key={g.section} className="flex flex-col">
              <span className="pb-1 text-xs font-medium">{g.section}</span>
              {g.entries.map((e) => (
                <div
                  key={e.key}
                  className="config-entry grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] items-center gap-2 border-t border-separator py-1 text-xs"
                >
                  <span className="truncate font-mono" title={e.key}>
                    {e.key}
                  </span>
                  <span
                    className="truncate font-mono text-muted"
                    title={e.value}
                  >
                    {e.value}
                  </span>
                  <LayerBadge layer={e.layer} />
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
