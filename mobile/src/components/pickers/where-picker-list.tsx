/**
 * The where sheet's content in React Native (iOS formSheet route, web
 * modal); Android draws the same in Compose (`where-picker-sheet.android.tsx`).
 *
 * ```text
 * Runs on                                 Runs on mac-A          (‹ back)
 * ● mac-A     2 projects · up to Edit  ›    theodore      ✓
 * ● build-box 1 project · up to Run         api
 * ○ Work Mac  Offline                (dim)
 *
 * a device with one project ─▶ picked, closed; several ─▶ its projects
 * a project ─▶ device + project picked (tick), closed
 * ```
 */
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { applyWhere } from '../../state/compose';
import { usePalette } from '../../ui/theme';
import { SymbolImage } from '../symbol-image';
import { tick } from './haptics';
import { SheetRow, SheetTitle } from './sheet-rows';
import { useDeviceRows, useHome } from './use-picker';
import { firstStep } from './where-steps';

export function WherePickerList({ onClose }: { onClose: () => void }) {
  const p = usePalette();
  const rows = useDeviceRows();
  const shown = useHome();
  const [step, setStep] = useState<string | null>(() => firstStep(rows));
  const open = step ? rows.find((r) => r.device.deviceId === step) : null;
  const pickProject = (deviceId: string, projectId: string) => {
    applyWhere(deviceId, projectId);
    tick();
    onClose();
  };

  if (open) {
    const several = rows.filter((r) => r.enabled).length > 1;
    return (
      <View className="pb-6" testID="where-picker">
        <SheetTitle
          leading={
            several ? (
              <Pressable
                onPress={() => setStep(null)}
                accessibilityRole="button"
                accessibilityLabel="Devices"
                hitSlop={10}
                className="-ml-1 h-8 w-8 items-center justify-center rounded-full active:bg-muted"
              >
                <SymbolImage
                  name="chevron.right"
                  size={16}
                  color={p.accent}
                  style={{ transform: [{ scaleX: -1 }] }}
                />
              </Pressable>
            ) : undefined
          }
        >
          {`Runs on ${open.device.name}`}
        </SheetTitle>
        {open.device.projects.map((x) => (
          <SheetRow
            key={x.id}
            label={x.name}
            selected={
              shown.device?.deviceId === open.device.deviceId &&
              shown.project?.id === x.id
            }
            onPress={() => pickProject(open.device.deviceId, x.id)}
          />
        ))}
      </View>
    );
  }

  return (
    <View className="pb-6" testID="where-picker">
      <SheetTitle>Runs on</SheetTitle>
      {rows.map((r) => {
        const d = r.device;
        const one = d.projects.length === 1 ? d.projects[0] : null;
        return (
          <SheetRow
            key={d.deviceId}
            label={d.name}
            detail={r.detail}
            dot={d.online ? 'on' : 'off'}
            disabled={!r.enabled}
            chevron={r.enabled && !one}
            selected={one ? shown.device?.deviceId === d.deviceId : undefined}
            accessibilityLabel={`${d.name}, ${d.online ? 'online' : 'offline'}, ${r.detail}`}
            onPress={() => {
              if (!r.enabled) return;
              if (one) pickProject(d.deviceId, one.id);
              else setStep(d.deviceId);
            }}
          />
        );
      })}
    </View>
  );
}
