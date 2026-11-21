/**
 * Home: where the space runs, two chips under the hint (docs/mobile.md
 * "New space").
 *
 * ```text
 *      ( 📁 theodore ⌄ )  on  ( 🖥 mac-A ⌄ )     centered; wraps as
 *        project sheet          computer sheet    "( 📁 long-project ⌄ )"
 *                                                 "on ( 🖥 Jean's MacBook Pro ⌄ )"
 *
 * the computer's only project ─▶ the project chip has no ⌄ and opens nothing
 * the computer chip always opens: its sheet holds the Mode
 * ```
 */
import { Text, View } from 'react-native';
import { MODE_LABEL } from '../../ui/logic';
import { SheetChip } from './sheet-chip';
import { useHome } from './use-picker';

export function WhereChips({ disabled }: { disabled?: boolean }) {
  const { device, project } = useHome();
  if (!device || !project) return null;
  return (
    <View
      testID="start-where"
      className="flex-row flex-wrap items-center justify-center gap-x-2 gap-y-2"
    >
      <SheetChip
        sheet="project"
        icon="folder"
        label={project.name}
        accessibilityLabel={`Project ${project.name}`}
        fixed={device.projects.length <= 1}
        disabled={disabled}
        testID="start-project"
      />
      {/* "on" travels with the computer chip when they wrap. */}
      <View className="flex-row items-center gap-2">
        <Text className="text-[13px] text-muted-foreground">on</Text>
        <SheetChip
          sheet="computer"
          icon="computer"
          label={device.name}
          accessibilityLabel={`Runs on ${device.name}, up to ${MODE_LABEL[device.maxMode]}`}
          disabled={disabled}
          testID="start-computer"
        />
      </View>
    </View>
  );
}
