/**
 * Android: the model sheet's content in Compose (inside the chip's
 * `ModalBottomSheet`); the same steps as `model-picker-list.tsx`: the top
 * models, All models (search from 9), Effort as a list, a space's Mode.
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
import { Fragment, useState } from 'react';
import {
  applyEffort,
  applyModel,
  resetPick,
  setSpaceMode,
} from '../../state/compose';
import { MODE_LABEL, modeRows } from '../../ui/logic';
import {
  SEARCH_MIN_MODELS,
  filterSections,
  type ModelRow,
} from '../../ui/modelPicker';
import { usePalette } from '../../ui/theme';
import { tick } from './haptics';
import {
  SheetBack,
  SheetDivider,
  SheetHeading,
  SheetRow,
  SheetTitle,
} from './sheet-parts.android';
import { useModelSheet, useSpaceMode } from './use-picker';

type Step = 'main' | 'all' | 'effort' | 'mode';

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
        semantics({ contentDescription: 'Search models' }),
      ]}
    >
      <OutlinedTextField.Placeholder>
        <Text>Search models</Text>
      </OutlinedTextField.Placeholder>
    </OutlinedTextField>
  );
}

export function ModelPickerSheet({
  space,
  onClose,
}: {
  space: string | null;
  onClose: () => void;
}) {
  const p = usePalette();
  const { agents, top, sections, effort, canReset, empty } =
    useModelSheet(space);
  // A space's next message's mode; Home's is in the computer sheet.
  const spaceMode = useSpaceMode(space);
  const [step, setStep] = useState<Step>('main');
  const [query, setQuery] = useState('');

  const pickModel = (r: ModelRow) => {
    const closes = applyModel(space, r.agent, r.model);
    tick();
    if (closes) onClose();
    else setStep('main');
  };
  const back = <SheetBack label="Model" onPress={() => setStep('main')} />;
  const reset = (
    <SheetRow
      label="Reset to defaults"
      accent
      disabled={!canReset}
      onPress={() => {
        resetPick(space);
        tick();
      }}
    />
  );
  const mods = [fillMaxWidth(), verticalScroll(), padding(0, 0, 0, 24)];

  if (step === 'all') {
    const shown = filterSections(sections, agents, query);
    return (
      <Column modifiers={mods}>
        <SheetTitle leading={back}>All models</SheetTitle>
        {top.total >= SEARCH_MIN_MODELS ? <Search onChange={setQuery} /> : null}
        {shown.map((s) => (
          <Fragment key={s.agent}>
            {s.title ? <SheetHeading>{s.title}</SheetHeading> : null}
            {s.rows.map((r) => (
              <SheetRow
                key={r.key}
                label={r.label}
                detail={r.subtitle}
                selected={r.selected}
                accessibilityLabel={r.accessibilityLabel}
                onPress={() => pickModel(r)}
              />
            ))}
          </Fragment>
        ))}
        {shown.length === 0 ? (
          <Text color={p.muted} modifiers={[padding(24, 8, 24, 8)]}>
            No model matches.
          </Text>
        ) : null}
        <SheetDivider />
        {reset}
      </Column>
    );
  }

  if (step === 'effort') {
    return (
      <Column modifiers={mods}>
        <SheetTitle leading={back}>Effort</SheetTitle>
        <SheetRow
          label={effort.defaultLabel}
          selected={effort.value === null}
          onPress={() => {
            applyEffort(space, null);
            tick();
            setStep('main');
          }}
        />
        <SheetDivider />
        {effort.choices.map((c) => (
          <SheetRow
            key={c.value}
            label={c.label}
            accessibilityLabel={c.accessibilityLabel}
            selected={effort.value === c.value}
            onPress={() => {
              applyEffort(space, c.value);
              tick();
              setStep('main');
            }}
          />
        ))}
      </Column>
    );
  }

  if (step === 'mode' && space && spaceMode) {
    return (
      <Column modifiers={mods}>
        <SheetTitle leading={back}>Mode</SheetTitle>
        {modeRows(spaceMode.modes, spaceMode.picked).map((r) => (
          <SheetRow
            key={r.mode}
            label={r.label}
            selected={r.selected}
            accessibilityLabel={`Mode: ${r.label}`}
            onPress={() => {
              setSpaceMode(space, r.mode);
              tick();
              setStep('main');
            }}
          />
        ))}
      </Column>
    );
  }

  const modeLabel = space && spaceMode ? MODE_LABEL[spaceMode.picked] : null;

  return (
    <Column modifiers={mods}>
      <SheetTitle>Model</SheetTitle>
      {empty ? (
        <Text color={p.muted} modifiers={[padding(24, 8, 24, 8)]}>
          This computer lists no agents to choose from.
        </Text>
      ) : null}
      {top.rows.map((r) => (
        <SheetRow
          key={r.key}
          label={r.label}
          detail={r.subtitle}
          selected={r.selected}
          accessibilityLabel={r.accessibilityLabel}
          onPress={() => pickModel(r)}
        />
      ))}
      {top.more || effort.choices.length > 0 || modeLabel ? (
        <SheetDivider />
      ) : null}
      {top.more ? (
        <SheetRow
          label="All models"
          value={String(top.total)}
          chevron
          accessibilityLabel={`All models, ${top.total}`}
          onPress={() => {
            setQuery('');
            setStep('all');
          }}
        />
      ) : null}
      {effort.choices.length > 0 ? (
        <SheetRow
          label="Effort"
          value={effort.summary}
          chevron
          accessibilityLabel={`Effort, ${effort.summary}`}
          onPress={() => setStep('effort')}
        />
      ) : null}
      {modeLabel ? (
        <SheetRow
          label="Mode"
          value={modeLabel}
          chevron
          accessibilityLabel={`Mode, ${modeLabel}`}
          onPress={() => setStep('mode')}
        />
      ) : null}
      {!top.more && !empty ? (
        <>
          <SheetDivider />
          {reset}
        </>
      ) : null}
    </Column>
  );
}
