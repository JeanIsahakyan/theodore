// Adapted from EvanBacon/chat-template (MIT)
/**
 * The model sheet's content in React Native (iOS formSheet route, web
 * modal); Android draws the same in Compose (`model-picker-sheet.android.tsx`).
 *
 * ```text
 * main                                 all                        effort
 * Model                                ‹ All models               ‹ Effort
 *   Opus 4.1        Claude   ✓         [Search models]  (9+)        Default (High) ✓
 *   GPT-5           Codex              CLAUDE                     ───
 * ───                                    Opus 4.1  Default ✓        Low
 *   All models               12 ›      ───                          Medium …
 *   Effort       Default (High) ›        Reset to defaults
 *
 * a model ─▶ applied (tick); closes when it takes no effort, else main
 * an effort ─▶ applied (tick), back to main
 * ```
 */
import { useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { applyEffort, applyModel, resetPick } from '../../state/compose';
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
} from './sheet-rows';
import { useModelSheet } from './use-picker';

type Step = 'main' | 'all' | 'effort';

export function ModelPickerList({
  space,
  onClose,
}: {
  space: string | null;
  onClose: () => void;
}) {
  const p = usePalette();
  const { agents, top, sections, effort, canReset, empty } =
    useModelSheet(space);
  const [step, setStep] = useState<Step>('main');
  const [query, setQuery] = useState('');

  const pickModel = (r: ModelRow) => {
    const closes = applyModel(space, r.agent, r.model);
    tick();
    if (closes) onClose();
    else setStep('main');
  };
  const back = <SheetBack label="Model" onPress={() => setStep('main')} />;

  if (step === 'all') {
    const shown = filterSections(sections, agents, query);
    return (
      <View className="pb-6" testID="model-picker-all">
        <SheetTitle leading={back}>All models</SheetTitle>
        {top.total >= SEARCH_MIN_MODELS ? (
          <View className="px-5 pt-1 pb-2">
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search models"
              placeholderTextColor={p.muted}
              autoCorrect={false}
              autoCapitalize="none"
              clearButtonMode="while-editing"
              accessibilityLabel="Search models"
              className="h-10 rounded-xl bg-muted px-3 text-[16px] text-foreground"
            />
          </View>
        ) : null}
        {shown.map((s) => (
          <View key={s.agent}>
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
          </View>
        ))}
        {shown.length === 0 ? (
          <Text className="px-5 py-3 text-[15px] text-muted-foreground">
            No model matches.
          </Text>
        ) : null}
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
      </View>
    );
  }

  if (step === 'effort') {
    return (
      <View className="pb-6" testID="model-picker-effort">
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
      </View>
    );
  }

  return (
    <View className="pb-6" testID="model-picker">
      <SheetTitle>Model</SheetTitle>
      {empty ? (
        <Text className="px-5 py-3 text-[15px] text-muted-foreground">
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
      {top.more || effort.choices.length > 0 ? <SheetDivider /> : null}
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
          testID="model-picker-all-row"
        />
      ) : null}
      {effort.choices.length > 0 ? (
        <SheetRow
          label="Effort"
          value={effort.summary}
          chevron
          accessibilityLabel={`Effort, ${effort.summary}`}
          onPress={() => setStep('effort')}
          testID="model-picker-effort-row"
        />
      ) : null}
      {!top.more && !empty ? (
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
      ) : null}
    </View>
  );
}
