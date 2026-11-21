/**
 * The composer's chip (docs/mobile.md "New space"):
 *
 * ```text
 * [Sonnet 4.5 High ▾]       a small chip (30 high, 13 pt), the effort muted
 *  ModelChip                 model sheet: agent · model · effort; in a
 *                            space also its Mode step
 * ```
 *
 * Read as "Agent: Claude, Opus 4.1, High". Where a new space runs is
 * `where-chips.tsx`; Home's mode is in the computer sheet.
 */
import { running, runningA11y, runningParts } from '../../ui/agents';
import { MODE_LABEL } from '../../ui/logic';
import { offersChoice } from '../../ui/modelPicker';
import { SheetChip } from './sheet-chip';
import { usePickerContext, useSpaceMode } from './use-picker';

/** Agent · model · effort of Home (`space` null) or a space. None when the
 *  host lists nothing to choose; in a space the chip then shows the mode,
 *  so its Mode step stays reachable. */
export function ModelChip({
  space = null,
  disabled,
}: {
  space?: string | null;
  disabled?: boolean;
}) {
  const { agents, pick, current } = usePickerContext(space);
  const spaceMode = useSpaceMode(space);
  const now = running(agents, pick, current);
  if (!now || !offersChoice(agents)) {
    if (!space || !spaceMode) return null;
    const mode = MODE_LABEL[spaceMode.picked];
    return (
      <SheetChip
        sheet="model"
        space={space}
        label={mode}
        accessibilityLabel={`Mode: ${mode}`}
        disabled={disabled}
        testID="space-model"
      />
    );
  }
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
