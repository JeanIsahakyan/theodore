/**
 * Android: Home's computer and project sheets in Compose (inside a
 * `ModalBottomSheet`); the same rows as `where-picker-list.tsx`.
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
import { applyDevice, applyWhere } from '../../state/compose';
import { PROJECT_SEARCH_MIN } from '../../ui/homeDraft';
import { usePalette } from '../../ui/theme';
import { tick } from './haptics';
import { SheetHeading, SheetRow, SheetTitle } from './sheet-parts.android';
import { useDeviceRows, useHome, useProjectGroups } from './use-picker';

const COLUMN = [fillMaxWidth(), verticalScroll(), padding(0, 0, 0, 24)];

export function ComputerPickerSheet({ onClose }: { onClose: () => void }) {
  const rows = useDeviceRows();
  const shown = useHome();
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
            selected={shown.device?.deviceId === d.deviceId}
            accessibilityLabel={`${d.name}, ${d.online ? 'online' : 'offline'}, ${r.detail}`}
            onPress={() => {
              applyDevice(d.deviceId);
              tick();
              onClose();
            }}
          />
        );
      })}
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
