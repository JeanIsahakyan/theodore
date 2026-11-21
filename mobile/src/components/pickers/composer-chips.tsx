/**
 * The composer's chips (docs/mobile.md "New space"):
 *
 * ```text
 * [Sonnet 4.5 High ▾]  [Edit ▾]       small chips (30 high, 13 pt)
 *  ModelChip            ModeMenu         the effort muted
 *  model sheet          quick menu (kit Menu)
 * ```
 *
 * Labels read by tests and screen readers: "Agent: Claude, Opus 4.1,
 * High", "Mode: Edit". Where it runs is `where-card.tsx`.
 */
import type { FleetMode } from '../../gen/fleet';
import { running, runningA11y, runningParts } from '../../ui/agents';
import { MODE_LABEL } from '../../ui/logic';
import { offersChoice } from '../../ui/modelPicker';
import { Menu } from '../../ui/native';
import { SheetChip } from './sheet-chip';
import { usePickerContext } from './use-picker';

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
  const { model, effort } = runningParts(now);
  return (
    <SheetChip
      sheet="model"
      space={space}
      label={model}
      detail={effort}
      accessibilityLabel={`Agent: ${runningA11y(now)}`}
      disabled={disabled}
      testID={space ? 'space-model' : 'start-model'}
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
      compact
      testID={testID}
    />
  );
}
