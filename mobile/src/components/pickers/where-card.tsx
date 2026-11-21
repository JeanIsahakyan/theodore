/**
 * Home: where the space runs, two rows at the top of the composer card
 * (docs/mobile.md "New space").
 *
 * ```text
 * │ 🖥  mac-A ●                 up to Edit  ⌄ │  ─▶ computer sheet
 * │ ──────────────────────────────────────── │
 * │ 📁  theodore                            ⌄ │  ─▶ project sheet (this computer's)
 *
 * one computer can take spaces ─▶ its row has no ⌄ and doesn't open
 * its only project            ─▶ the same for the project row
 * ```
 */
import { Pressable, Text, View } from 'react-native';
import { MODE_LABEL } from '../../ui/logic';
import { usePalette } from '../../ui/theme';
import { SymbolImage, type SymbolName } from '../symbol-image';
import { useSheet } from './sheet-host';
import type { SheetKind } from './types';
import { useDeviceRows, useHome } from './use-picker';

function WhereRow({
  kind,
  icon,
  label,
  dot,
  value,
  accessibilityLabel,
  fixed,
  disabled,
  testID,
}: {
  kind: SheetKind;
  icon: SymbolName;
  label: string;
  dot?: boolean;
  value?: string;
  accessibilityLabel: string;
  /** Nothing else to choose: no ⌄, not pressable. */
  fixed: boolean;
  disabled?: boolean;
  testID: string;
}) {
  const p = usePalette();
  const sheet = useSheet(kind);
  const off = fixed || disabled;
  return (
    <>
      <Pressable
        onPress={sheet.open}
        disabled={off}
        accessibilityRole={fixed ? 'text' : 'button'}
        accessibilityLabel={accessibilityLabel}
        accessibilityState={{ disabled: !!disabled, expanded: sheet.isOpen }}
        testID={testID}
        className={`h-10 flex-row items-center gap-2.5 px-4 ${off ? '' : 'active:opacity-60'} ${disabled ? 'opacity-45' : ''}`}
      >
        <SymbolImage name={icon} size={16} color={p.muted} />
        <Text
          numberOfLines={1}
          className="shrink text-[15px] font-medium text-foreground"
        >
          {label}
        </Text>
        {dot ? <View className="h-2 w-2 rounded-full bg-success" /> : null}
        <View className="flex-1" />
        {value ? (
          <Text numberOfLines={1} className="text-[13px] text-muted-foreground">
            {value}
          </Text>
        ) : null}
        {fixed ? null : (
          <SymbolImage
            name="chevron.up.chevron.down"
            size={12}
            color={p.muted}
          />
        )}
      </Pressable>
      {sheet.element}
    </>
  );
}

export function WhereCard({ disabled }: { disabled?: boolean }) {
  const { device, project } = useHome();
  const rows = useDeviceRows();
  if (!device || !project) return null;
  const choices = rows.filter((r) => r.enabled).length;
  return (
    <View testID="start-where">
      <WhereRow
        kind="computer"
        icon="computer"
        label={device.name}
        dot={device.online}
        value={`up to ${MODE_LABEL[device.maxMode]}`}
        accessibilityLabel={`Runs on ${device.name}`}
        fixed={choices <= 1}
        disabled={disabled}
        testID="start-computer"
      />
      <View className="mx-4 h-px bg-border/60" />
      <WhereRow
        kind="project"
        icon="folder"
        label={project.name}
        accessibilityLabel={`Project ${project.name}`}
        fixed={device.projects.length <= 1}
        disabled={disabled}
        testID="start-project"
      />
    </View>
  );
}
