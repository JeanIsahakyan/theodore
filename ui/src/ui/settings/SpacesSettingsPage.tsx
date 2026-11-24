/**
 * Settings → Spaces: the Spaces on/off switch, turn notifications, the
 * defaults every project starts from (auto-archive, sub-space limits), and
 * the global config file. A project's own values live in its settings
 * (Project settings → Spaces, `ProjectSpaces`), which override these.
 */
import { useEffect, useState, type ReactNode } from 'react';

import { Card, InputGroup, Switch, TextField, Typography } from '@heroui/react';
import { observer } from 'mobx-react-lite';
import { setSetting } from '../../actions';
import { FEATURES } from '../../features';
import { useRootStore } from '../../stores/context';
import { GlobalConfigSection } from '../space/ConfigSection';
import { isBuildMode } from '../space/mode';
import {
  SPACE_SETTINGS,
  effectiveSpaceSetting,
  type SpaceSettingSpec,
} from '../space/spaceSettings';
import { BUILD_MODE_KEY, NOTIFY_KEY, notifyOn } from '../space/spaces';

export const SpacesSettingsPage = observer(function SpacesSettingsPage() {
  const store = useRootStore();
  const on = isBuildMode(store);
  return (
    <section className="spaces-settings flex flex-col gap-2">
      <Card
        variant="secondary"
        className="flex flex-row items-center gap-3 px-4 py-3"
      >
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
          Spaces in the sidebar, ⌥N for a new one. Off hides them everywhere;
          existing spaces stay on disk.
        </span>
      </Card>
      {on && (
        <>
          <Card variant="secondary" className="gap-0 p-0">
            <SwitchRow
              label="Notify when a turn ends"
              hint="A system notification when a space's turn finishes or fails while Theodore is in the background; the dock badge counts the spaces waiting for you."
              isSelected={notifyOn(store.models.settings.all())}
              onChange={(v) => setSetting(store, 'user', NOTIFY_KEY, v)}
            />
          </Card>
          <Typography.Heading level={6} className="mt-2">
            Defaults for every project
          </Typography.Heading>
          <Card variant="secondary" className="gap-0 p-0">
            {SPACE_SETTINGS.map((spec) => (
              <GlobalSettingRow key={spec.key} spec={spec} />
            ))}
          </Card>
          <span className="text-xs text-muted">
            A project can set its own values: Project settings → Spaces.
          </span>
          <GlobalConfigSection />
        </>
      )}
    </section>
  );
});

/** One default: a number (empty = the built-in default, shown as the
 *  placeholder) or a switch, in the `user` scope. */
const GlobalSettingRow = observer(function GlobalSettingRow({
  spec,
}: {
  spec: SpaceSettingSpec;
}) {
  const store = useRootStore();
  if (spec.kind === 'boolean') {
    const v = effectiveSpaceSetting(store.models.settings.all(), spec.key)
      .value as boolean;
    return (
      <SwitchRow
        label={spec.label}
        hint={spec.hint}
        isSelected={v}
        onChange={(on) => setSetting(store, 'user', spec.key, on)}
      />
    );
  }
  return (
    <NumberSettingRow
      scope="user"
      settingKey={spec.key}
      label={spec.label}
      hint={spec.hint}
      placeholder={String(spec.default)}
      accept={spec.accept}
    />
  );
});

/** A setting row's left side: the label, the hint, and (a project's
 *  rows) what is in effect and where it comes from. */
function RowText({
  label,
  hint,
  source,
}: {
  label: string;
  hint: string;
  source?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="text-sm font-medium">{label}</span>
      <span className="text-xs text-muted">{hint}</span>
      {source && <span className="text-xs text-muted">{source}</span>}
    </div>
  );
}

export function SwitchRow({
  label,
  hint,
  source,
  isSelected,
  onChange,
  trailing,
  className,
}: {
  label: string;
  hint: string;
  source?: ReactNode;
  isSelected: boolean;
  onChange: (v: boolean) => void;
  /** After the switch: a Reset button, say. */
  trailing?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`set-row flex items-center gap-4 border-b border-separator px-4 py-3 last:border-b-0 ${className ?? ''}`}
    >
      <RowText label={label} hint={hint} source={source} />
      <Switch
        size="sm"
        aria-label={label}
        isSelected={isSelected}
        onChange={onChange}
      >
        <Switch.Content>
          <Switch.Control>
            <Switch.Thumb />
          </Switch.Control>
        </Switch.Content>
      </Switch>
      {trailing}
    </div>
  );
}

/** One numeric setting in `scope`; empty clears the row (what it inherits
 *  applies, shown as the placeholder). */
export const NumberSettingRow = observer(function NumberSettingRow({
  scope,
  settingKey,
  label,
  hint,
  source,
  placeholder,
  accept,
  trailing,
  className,
}: {
  scope: string;
  settingKey: string;
  label: string;
  hint: string;
  source?: ReactNode;
  placeholder: string;
  accept: (n: number) => boolean;
  /** After the field: a Reset button, say. */
  trailing?: ReactNode;
  className?: string;
}) {
  const store = useRootStore();
  const raw = store.models.settings.get(`${scope}:${settingKey}`)?.value;
  const [text, setText] = useState(typeof raw === 'number' ? String(raw) : '');
  useEffect(() => {
    setText(typeof raw === 'number' ? String(raw) : '');
  }, [raw]);
  const save = () => {
    const t = text.trim();
    if (!t) {
      if (raw !== undefined) setSetting(store, scope, settingKey, null);
      return;
    }
    const n = Number(t);
    if (Number.isFinite(n) && accept(n)) {
      setSetting(store, scope, settingKey, n);
    } else {
      // Not accepted: back to what is stored.
      setText(typeof raw === 'number' ? String(raw) : '');
    }
  };
  return (
    <div
      className={`set-row flex items-center gap-4 border-b border-separator px-4 py-3 last:border-b-0 ${className ?? ''}`}
    >
      <RowText label={label} hint={hint} source={source} />
      <TextField
        value={text}
        onChange={setText}
        aria-label={label}
        className="w-32 shrink-0"
      >
        <InputGroup className="w-full rounded-xl">
          <InputGroup.Input
            placeholder={placeholder}
            inputMode="decimal"
            className="w-full min-w-0 text-right text-sm"
            onBlur={save}
            onKeyDown={(e) => e.key === 'Enter' && save()}
          />
        </InputGroup>
      </TextField>
      {trailing}
    </div>
  );
});
