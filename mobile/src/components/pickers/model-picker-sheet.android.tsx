/**
 * Android: the model sheet's content in Compose (inside the chip's
 * `ModalBottomSheet`); the same rows as `model-picker-list.tsx`, the
 * effort a Material 3 `SingleChoiceSegmentedButtonRow`.
 */
import {
  Column,
  SegmentedButton,
  SingleChoiceSegmentedButtonRow,
  Text,
} from '@expo/ui/jetpack-compose';
import {
  fillMaxWidth,
  padding,
  semantics,
  verticalScroll,
} from '@expo/ui/jetpack-compose/modifiers';
import { Fragment } from 'react';
import { applyEffort, applyModel, resetPick } from '../../state/compose';
import { usePalette } from '../../ui/theme';
import { tick } from './haptics';
import {
  SheetDivider,
  SheetHeading,
  SheetRow,
  SheetTitle,
} from './sheet-parts.android';
import { useModelSheet } from './use-picker';

export function ModelPickerSheet({
  space,
  onClose,
}: {
  space: string | null;
  onClose: () => void;
}) {
  const p = usePalette();
  const { sections, effort, canReset, empty } = useModelSheet(space);
  return (
    <Column
      modifiers={[fillMaxWidth(), verticalScroll(), padding(0, 0, 0, 24)]}
    >
      <SheetTitle>Model</SheetTitle>
      {empty ? (
        <Text color={p.muted} modifiers={[padding(24, 8, 24, 8)]}>
          This computer lists no agents to choose from.
        </Text>
      ) : null}
      {sections.map((s) => (
        <Fragment key={s.agent}>
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
        </Fragment>
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
          <SingleChoiceSegmentedButtonRow
            modifiers={[
              fillMaxWidth(),
              padding(24, 4, 24, 8),
              semantics({ contentDescription: 'Effort' }),
            ]}
          >
            {effort.choices.map((c) => (
              <SegmentedButton
                key={c.value}
                selected={c.value === effort.value}
                onClick={() => {
                  applyEffort(space, c.value);
                  tick();
                }}
                modifiers={[
                  semantics({ contentDescription: c.accessibilityLabel }),
                ]}
              >
                <SegmentedButton.Label>
                  <Text maxLines={1}>{c.label}</Text>
                </SegmentedButton.Label>
              </SegmentedButton>
            ))}
          </SingleChoiceSegmentedButtonRow>
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
    </Column>
  );
}
