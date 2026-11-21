/**
 * Home's computer and project sheets in React Native (iOS formSheet
 * routes, web modal); Android draws the same in Compose
 * (`where-picker-sheet.android.tsx`).
 *
 * ```text
 * Computer                      ‹ Mode            Project · mac-A
 * ● mac-A     3 projects · up to Edit ✓   Ask      [Search projects]   (7+)
 * ● build-box 1 project · up to Run       Plan     RECENT
 * ○ Work Mac  Offline              (dim)  Edit ✓     theodore        ✓
 * ───                                              ALL
 * Mode                          Edit ›               cloud
 *
 * a computer ─▶ applyDevice(): its last project, else its first; closed
 * a mode     ─▶ setHomeMode(), back to the computers (the sheet stays)
 * a project  ─▶ applyWhere(): picked, closed
 * ```
 */
import { useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { applyDevice, applyWhere, setHomeMode } from '../../state/compose';
import { PROJECT_SEARCH_MIN } from '../../ui/homeDraft';
import { MODE_LABEL, modeRows, modesUpTo } from '../../ui/logic';
import { usePalette } from '../../ui/theme';
import { tick } from './haptics';
import {
  SheetBack,
  SheetDivider,
  SheetHeading,
  SheetRow,
  SheetTitle,
} from './sheet-rows';
import { useDeviceRows, useHome, useProjectGroups } from './use-picker';

type ComputerStep = 'main' | 'mode';

export function ComputerPickerList({ onClose }: { onClose: () => void }) {
  const rows = useDeviceRows();
  const { device, mode } = useHome();
  const [step, setStep] = useState<ComputerStep>('main');

  if (step === 'mode' && device) {
    return (
      <View className="pb-6" testID="computer-picker-mode">
        <SheetTitle
          leading={
            <SheetBack label="Computer" onPress={() => setStep('main')} />
          }
        >
          Mode
        </SheetTitle>
        {modeRows(modesUpTo(device.maxMode), mode).map((r) => (
          <SheetRow
            key={r.mode}
            label={r.label}
            selected={r.selected}
            accessibilityLabel={`Mode: ${r.label}`}
            onPress={() => {
              setHomeMode(r.mode);
              tick();
              setStep('main');
            }}
          />
        ))}
      </View>
    );
  }

  return (
    <View className="pb-6" testID="computer-picker">
      <SheetTitle>Computer</SheetTitle>
      {rows.map((r) => {
        const d = r.device;
        return (
          <SheetRow
            key={d.deviceId}
            label={d.name}
            detail={r.detail}
            dot={d.online ? 'on' : 'off'}
            disabled={!r.enabled}
            selected={device?.deviceId === d.deviceId}
            accessibilityLabel={`${d.name}, ${d.online ? 'online' : 'offline'}, ${r.detail}`}
            onPress={() => {
              applyDevice(d.deviceId);
              tick();
              onClose();
            }}
          />
        );
      })}
      {device ? (
        <>
          <SheetDivider />
          <SheetRow
            label="Mode"
            value={MODE_LABEL[mode]}
            chevron
            accessibilityLabel={`Mode, ${MODE_LABEL[mode]}`}
            onPress={() => setStep('mode')}
            testID="computer-picker-mode-row"
          />
        </>
      ) : null}
    </View>
  );
}

export function ProjectPickerList({ onClose }: { onClose: () => void }) {
  const p = usePalette();
  const [query, setQuery] = useState('');
  const { device, project } = useHome();
  const groups = useProjectGroups(query);
  if (!device) return null;
  const pick = (projectId: string) => {
    applyWhere(device.deviceId, projectId);
    tick();
    onClose();
  };
  const row = (x: { id: string; name: string }) => (
    <SheetRow
      key={x.id}
      label={x.name}
      selected={project?.id === x.id}
      onPress={() => pick(x.id)}
    />
  );
  const headings = groups.recent.length > 0 && groups.rest.length > 0;
  return (
    <View className="pb-6" testID="project-picker">
      <SheetTitle>{`Project · ${device.name}`}</SheetTitle>
      {device.projects.length >= PROJECT_SEARCH_MIN ? (
        <View className="px-5 pt-1 pb-2">
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search projects"
            placeholderTextColor={p.muted}
            autoCorrect={false}
            autoCapitalize="none"
            clearButtonMode="while-editing"
            accessibilityLabel="Search projects"
            className="h-10 rounded-xl bg-muted px-3 text-[16px] text-foreground"
          />
        </View>
      ) : null}
      {headings ? <SheetHeading>Recent</SheetHeading> : null}
      {groups.recent.map(row)}
      {headings ? <SheetHeading>All</SheetHeading> : null}
      {groups.rest.map(row)}
      {groups.recent.length + groups.rest.length === 0 ? (
        <Text className="px-5 py-3 text-[15px] text-muted-foreground">
          No project matches.
        </Text>
      ) : null}
    </View>
  );
}
