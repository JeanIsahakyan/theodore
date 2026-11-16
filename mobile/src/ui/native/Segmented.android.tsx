/** Android: Material 3 `SingleChoiceSegmentedButtonRow`. */
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
  testID as testIDMod,
} from '@expo/ui/jetpack-compose/modifiers';
import { useInForm } from './context';
import { ControlHost } from './host.android';
import type { SegmentedProps } from './types';

export function Segmented<T extends string>({
  label,
  choices,
  value,
  onChange,
  disabled,
  accessibilityLabel,
  testID,
  style,
}: SegmentedProps<T>) {
  const inForm = useInForm();
  const row = (
    <SingleChoiceSegmentedButtonRow
      modifiers={[
        fillMaxWidth(),
        semantics({ contentDescription: accessibilityLabel ?? label }),
        ...(testID ? [testIDMod(testID)] : []),
      ]}
    >
      {choices.map((c) => (
        <SegmentedButton
          key={c.value}
          selected={c.value === value}
          enabled={!disabled}
          onClick={() => onChange(c.value)}
          modifiers={
            c.accessibilityLabel
              ? [semantics({ contentDescription: c.accessibilityLabel })]
              : undefined
          }
        >
          <SegmentedButton.Label>
            <Text>{c.label}</Text>
          </SegmentedButton.Label>
        </SegmentedButton>
      ))}
    </SingleChoiceSegmentedButtonRow>
  );
  return (
    <ControlHost style={style} width="fill">
      {inForm ? (
        <Column modifiers={[padding(16, 8, 16, 8)]}>{row}</Column>
      ) : (
        row
      )}
    </ControlHost>
  );
}
