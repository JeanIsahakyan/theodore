/**
 * The composer's chips (docs/mobile.md "New space"):
 *
 * ```text
 * [mac-A · repo ▾]  [Sonnet 4.5 · High ▾]  [Edit ▾]
 *  WhereChip         ModelChip              ModeMenu
 *  where sheet       model sheet            quick menu (kit Menu)
 * ```
 *
 * Labels read by tests and screen readers: "Runs on mac-A, project repo",
 * "Agent: Claude, Opus 4.1, High", "Mode: Edit".
 */
import type { FleetMode } from '../../gen/fleet';
import { running, runningA11y, runningLabel } from '../../ui/agents';
import { whereLabel } from '../../ui/homeDraft';
import { MODE_LABEL } from '../../ui/logic';
import { offersChoice } from '../../ui/modelPicker';
import { Menu } from '../../ui/native';
import { SheetChip } from './sheet-chip';
import { useHome, usePickerContext } from './use-picker';

/** Agent · model · effort of Home (`space` null) or a space; none when the
 *  host lists nothing to choose. */
export function ModelChip({
  space = null,
  disabled,
}: {
  space?: string | null;
  disabled?: boolean;
}) {
  const { agents, pick, current } = usePickerContext(space);
  const now = running(agents, pick, current);
  if (!now || !offersChoice(agents)) return null;
  return (
    <SheetChip
      sheet="model"
      space={space}
      label={runningLabel(now)}
      accessibilityLabel={`Agent: ${runningA11y(now)}`}
      disabled={disabled}
      testID={space ? 'space-model' : 'start-model'}
    />
  );
}

/** Home: the device and project the space starts on. */
export function WhereChip({ disabled }: { disabled?: boolean }) {
  const { device, project } = useHome();
  if (!device || !project) return null;
  const { label, accessibilityLabel } = whereLabel(device, project);
  return (
    <SheetChip
      sheet="where"
      label={label}
      accessibilityLabel={accessibilityLabel}
      disabled={disabled}
      testID="start-where"
    />
  );
}

/** The mode, up to what the device allows: a quick menu. */
export function ModeMenu({
  modes,
  value,
  onChange,
  disabled,
  testID,
}: {
  modes: readonly FleetMode[];
  value: FleetMode;
  onChange: (m: FleetMode) => void;
  disabled?: boolean;
  testID?: string;
}) {
  return (
    <Menu
      label={MODE_LABEL[value]}
      accessibilityLabel={`Mode: ${MODE_LABEL[value]}`}
      groups={[
        {
          label: 'Mode',
          choices: modes.map((m) => ({ value: m, label: MODE_LABEL[m] })),
          value,
          onChange: (m) => onChange(m as FleetMode),
        },
      ]}
      disabled={disabled}
      testID={testID}
    />
  );
}
