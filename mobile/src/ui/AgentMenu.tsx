/**
 * The composer's agent · model · effort chip for a space on another device
 * (docs/fleet.md "Agent, model and effort"): the host's own list, what runs
 * now, and a pick for the next message on. Hidden when the host lists no
 * agents (an older one), or offers nothing to choose.
 *
 * ```text
 * ( Opus 4.1 · High ⌄ ) ─▶ Agent (2+ listed) · Model · Effort (if it takes one)
 * ```
 *
 * iOS: a SwiftUI menu; Android: a chip opening a Material 3 bottom sheet
 * (`components/picker-menu`). `glass` (default on): over content.
 */
import type { StyleProp, ViewStyle } from 'react-native';
import type { FleetAgentView } from '../fleet/types';
import {
  effortLabel,
  pickAgent,
  pickEffort,
  pickModel,
  running,
  runningA11y,
  runningLabel,
  type Pick,
} from './agents';
import { PickerMenu } from '../components/picker-menu';
import type { MenuGroup } from './native';

export function AgentMenu({
  agents,
  pick,
  current,
  onPick,
  disabled,
  glass = true,
  style,
}: {
  agents: readonly FleetAgentView[];
  pick: Pick;
  /** The space's own (its mirrored row). */
  current: Pick;
  onPick: (next: Pick) => void;
  disabled?: boolean;
  glass?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const now = running(agents, pick, current);
  if (!now) return null;
  const groups: MenuGroup[] = [];
  if (agents.length > 1) {
    groups.push({
      label: 'Agent',
      choices: agents.map((a) => ({ value: a.id, label: a.label })),
      value: now.agent.id,
      onChange: (a) => onPick(pickAgent(a)),
    });
  }
  if (now.agent.models.length > 0) {
    groups.push({
      label: 'Model',
      choices: now.agent.models.map((m) => ({ value: m.id, label: m.label })),
      value: now.model?.id ?? null,
      onChange: (m) => onPick(pickModel(agents, pick, current, m)),
    });
  }
  if (now.levels.length > 0) {
    groups.push({
      label: 'Effort',
      choices: now.levels.map((e) => ({ value: e, label: effortLabel(e) })),
      value: now.effort,
      onChange: (e) => onPick(pickEffort(pick, e)),
    });
  }
  if (groups.length === 0) return null;
  return (
    <PickerMenu
      label={runningLabel(now)}
      accessibilityLabel={`Agent: ${runningA11y(now)}`}
      groups={groups}
      disabled={disabled}
      glass={glass}
      style={style}
    />
  );
}
