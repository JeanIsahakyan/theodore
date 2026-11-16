// Adapted from EvanBacon/chat-template (MIT)
/**
 * The model sheet's content in React Native (iOS formSheet route, web
 * modal); Android draws the same in Compose (`model-picker-sheet.android.tsx`).
 *
 * ```text
 * Model
 * CLAUDE                          heading per agent (2+ listed)
 *   Opus 4.1          Default ✓   tap ─▶ applied at once (tick); closes when
 *   Sonnet 4.5        Claude            the new model takes no effort
 * ───
 * EFFORT
 *   Default (High)            ✓   nothing picked
 *   [Low|Med|High|XHigh|Max|Ultra]
 * ───
 *   Reset to defaults             nothing picked: the host's (a space: its own)
 * ```
 */
import { Text, View } from 'react-native';
import { applyEffort, applyModel, resetPick } from '../../state/compose';
import { Segmented } from '../../ui/native';
import { tick } from './haptics';
import { SheetDivider, SheetHeading, SheetRow, SheetTitle } from './sheet-rows';
import { useModelSheet } from './use-picker';

/** The segmented control's value while nothing is picked (no segment). */
const DEFAULT = '';

export function ModelPickerList({
  space,
  onClose,
}: {
  space: string | null;
  onClose: () => void;
}) {
  const { sections, effort, canReset, empty } = useModelSheet(space);
  return (
    <View className="pb-6" testID="model-picker">
      <SheetTitle>Model</SheetTitle>
      {empty ? (
        <Text className="px-5 py-3 text-[15px] text-muted-foreground">
          This computer lists no agents to choose from.
        </Text>
      ) : null}
      {sections.map((s) => (
        <View key={s.agent}>
          {s.title ? <SheetHeading>{s.title}</SheetHeading> : null}
          {s.rows.map((r) => (
            <SheetRow
              key={r.key}
              label={r.label}
              detail={r.subtitle}
              selected={r.selected}
              accessibilityLabel={r.accessibilityLabel}
              onPress={() => {
                const closes = applyModel(space, r.agent, r.model);
                tick();
                if (closes) onClose();
              }}
            />
          ))}
        </View>
      ))}
      {effort.choices.length > 0 ? (
        <>
          <SheetDivider />
          <SheetHeading>Effort</SheetHeading>
          <SheetRow
            label={effort.defaultLabel}
            selected={effort.value === null}
            onPress={() => {
              applyEffort(space, null);
              tick();
            }}
          />
          <View className="px-5 pt-1 pb-2">
            <Segmented<string>
              label="Effort"
              choices={effort.choices}
              value={effort.value ?? DEFAULT}
              onChange={(e) => {
                applyEffort(space, e);
                tick();
              }}
              testID="model-picker-effort"
            />
          </View>
        </>
      ) : null}
      {empty ? null : (
        <>
          <SheetDivider />
          <SheetRow
            label="Reset to defaults"
            accent
            disabled={!canReset}
            onPress={() => {
              resetPick(space);
              tick();
            }}
          />
        </>
      )}
    </View>
  );
}
