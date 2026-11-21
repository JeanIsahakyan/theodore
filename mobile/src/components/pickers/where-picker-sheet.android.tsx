/**
 * Android: Home's computer and project sheets in Compose (inside a
 * `ModalBottomSheet`); the same rows and steps as `where-picker-list.tsx`
 * (the computer sheet's Mode step included).
 */
import {
  Column,
  OutlinedTextField,
  Text,
  useNativeState,
} from '@expo/ui/jetpack-compose';
import {
  fillMaxWidth,
  padding,
  semantics,
  verticalScroll,
} from '@expo/ui/jetpack-compose/modifiers';
import { useState } from 'react';
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
} from './sheet-parts.android';
import { useDeviceRows, useHome, useProjectGroups } from './use-picker';

const COLUMN = [fillMaxWidth(), verticalScroll(), padding(0, 0, 0, 24)];

type ComputerStep = 'main' | 'mode';

export function ComputerPickerSheet({ onClose }: { onClose: () => void }) {
  const rows = useDeviceRows();
  const { device, mode } = useHome();
  const [step, setStep] = useState<ComputerStep>('main');

  if (step === 'mode' && device) {
    return (
      <Column modifiers={COLUMN}>
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
      </Column>
    );
  }

  return (
    <Column modifiers={COLUMN}>
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
          />
        </>
      ) : null}
    </Column>
  );
}

function Search({ onChange }: { onChange: (q: string) => void }) {
  const text = useNativeState('');
  return (
    <OutlinedTextField
      value={text}
      singleLine
      keyboardOptions={{
        capitalization: 'none',
        autoCorrectEnabled: false,
        imeAction: 'search',
      }}
      onValueChange={onChange}
      modifiers={[
        fillMaxWidth(),
        padding(24, 4, 24, 8),
        semantics({ contentDescription: 'Search projects' }),
      ]}
    >
      <OutlinedTextField.Placeholder>
        <Text>Search projects</Text>
      </OutlinedTextField.Placeholder>
    </OutlinedTextField>
  );
}

export function ProjectPickerSheet({ onClose }: { onClose: () => void }) {
  const p = usePalette();
  const [query, setQuery] = useState('');
  const { device, project } = useHome();
  const groups = useProjectGroups(query);
  if (!device) return null;
  const deviceId = device.deviceId;
  const row = (x: { id: string; name: string }) => (
    <SheetRow
      key={x.id}
      label={x.name}
      selected={project?.id === x.id}
      onPress={() => {
        applyWhere(deviceId, x.id);
        tick();
        onClose();
      }}
    />
  );
  const headings = groups.recent.length > 0 && groups.rest.length > 0;
  return (
    <Column modifiers={COLUMN}>
      <SheetTitle>{`Project · ${device.name}`}</SheetTitle>
      {device.projects.length >= PROJECT_SEARCH_MIN ? (
        <Search onChange={setQuery} />
      ) : null}
      {headings ? <SheetHeading>Recent</SheetHeading> : null}
      {groups.recent.map(row)}
      {headings ? <SheetHeading>All</SheetHeading> : null}
      {groups.rest.map(row)}
      {groups.recent.length + groups.rest.length === 0 ? (
        <Text color={p.muted} modifiers={[padding(24, 8, 24, 8)]}>
          No project matches.
        </Text>
      ) : null}
    </Column>
  );
}
