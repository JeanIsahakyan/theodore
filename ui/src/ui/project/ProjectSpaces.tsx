/**
 * Project settings → Spaces: the project's config as it applies to its
 * spaces (the merged `spaces:` commands — files, layers, values, trust —
 * read-only, with a way to the editor), then its own values for the space
 * settings: each row shows what is in effect and where it comes from
 * (Default · Global · This project), takes an override, and resets to the
 * global default (docs/spaces.md §7, "Sub-spaces").
 */
import { useEffect, useState } from 'react';

import { Button, Card, Typography } from '@heroui/react';
import { observer } from 'mobx-react-lite';
import type { EffectiveConfig, Project } from '../../gen/contract';
import { setSetting } from '../../actions';
import { api } from '../../core/api';
import { projectSettingsRoute } from '../../core/workspaces';
import { useRootStore, useUi } from '../../stores/context';
import { Spinner } from '../bits';
import { EffectiveConfigView } from '../space/ConfigSection';
import {
  SPACE_SETTINGS,
  SPACE_SOURCE_LABEL,
  effectiveSpaceSetting,
  formatSpaceSetting,
  projectOverride,
  projectScope,
  type SpaceSettingSpec,
} from '../space/spaceSettings';
import { NumberSettingRow, SwitchRow } from '../settings/SpacesSettingsPage';

export const ProjectSpaces = observer(function ProjectSpaces({
  project,
}: {
  project: Project;
}) {
  return (
    <>
      <ProjectCommands project={project} />
      <ProjectOverrides project={project} />
    </>
  );
});

/** The merged config, read-only; Edit opens the Config section. */
function ProjectCommands({ project }: { project: Project }) {
  const ui = useUi();
  const [config, setConfig] = useState<EffectiveConfig | null>(null);
  const [failed, setFailed] = useState(false);
  // Keyed by the project in `ProjectSettingsPage`: a new project is a
  // fresh component, so nothing to reset here.
  useEffect(() => {
    let on = true;
    api
      .projectConfig(project.id)
      .then((c) => on && setConfig(c))
      .catch(() => on && setFailed(true));
    return () => {
      on = false;
    };
  }, [project.id]);
  return (
    <section className="project-commands flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Typography.Heading level={6} className="flex-1">
          Commands
        </Typography.Heading>
        <Button
          size="sm"
          variant="secondary"
          className="project-config-edit"
          onPress={() => ui.go(projectSettingsRoute(project.id, 'config'))}
        >
          Edit config
        </Button>
      </div>
      <Card variant="secondary" className="flex flex-col gap-3 px-4 py-3">
        {failed ? (
          <span className="text-xs text-danger">
            Could not read this project's config.
          </span>
        ) : !config ? (
          <Spinner />
        ) : (
          <EffectiveConfigView config={config} />
        )}
      </Card>
      <span className="text-xs text-muted">
        Setup, run, check and archive come from the project’s config files; a
        repo’s commands run once you allow them.
      </span>
    </section>
  );
}

/** The space settings for this project: an override per row, or what the
 *  global default says. */
const ProjectOverrides = observer(function ProjectOverrides({
  project,
}: {
  project: Project;
}) {
  return (
    <section className="project-space-settings flex flex-col gap-2">
      <Typography.Heading level={6}>Space settings</Typography.Heading>
      <Card variant="secondary" className="gap-0 p-0">
        {SPACE_SETTINGS.map((spec) => (
          <OverrideRow key={spec.key} spec={spec} project={project.id} />
        ))}
      </Card>
      <span className="text-xs text-muted">
        Empty means the global default (Settings → Spaces). A value here applies
        to this project’s spaces only.
      </span>
    </section>
  );
});

const OverrideRow = observer(function OverrideRow({
  spec,
  project,
}: {
  spec: SpaceSettingSpec;
  project: string;
}) {
  const store = useRootStore();
  const settings = store.models.settings.all();
  const scope = projectScope(project);
  const eff = effectiveSpaceSetting(settings, spec.key, project);
  const own = projectOverride(settings, spec.key, project);
  const inherited = effectiveSpaceSetting(settings, spec.key);
  const source = (
    <span className="set-source">
      {SPACE_SOURCE_LABEL[eff.source]}
      {eff.source !== 'project' &&
        ` · ${formatSpaceSetting(spec.key, eff.value)}`}
    </span>
  );
  const reset =
    own !== undefined ? (
      <Button
        size="sm"
        variant="ghost"
        className="set-reset h-7 shrink-0 px-2 text-xs"
        onPress={() => setSetting(store, scope, spec.key, null)}
      >
        Reset to default
      </Button>
    ) : null;
  if (spec.kind === 'boolean') {
    return (
      <SwitchRow
        className={`override-${spec.key.replace(/\./g, '-')}`}
        label={spec.label}
        hint={spec.hint}
        source={source}
        isSelected={eff.value as boolean}
        onChange={(on) => setSetting(store, scope, spec.key, on)}
        trailing={reset}
      />
    );
  }
  return (
    <NumberSettingRow
      className={`override-${spec.key.replace(/\./g, '-')}`}
      scope={scope}
      settingKey={spec.key}
      label={spec.label}
      hint={spec.hint}
      source={source}
      placeholder={String(inherited.value)}
      accept={spec.accept}
      trailing={reset}
    />
  );
});
