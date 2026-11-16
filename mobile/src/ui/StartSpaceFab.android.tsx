/**
 * Android: the Spaces list's main action as a Material 3 extended FAB
 * ("+ Start a space"), bottom-right over the list. The kit has no FAB
 * (docs/mobile.md "Native UI"), so this wraps `@expo/ui` directly, themed
 * like the kit's hosts.
 */
import {
  ExtendedFloatingActionButton,
  Host,
  Icon,
  Text,
} from '@expo/ui/jetpack-compose';
import { semantics } from '@expo/ui/jetpack-compose/modifiers';
import { StyleSheet } from 'react-native';
import { useHostTheme } from './native/host.android';
import { usePalette } from './theme';

export const FAB_CLEARANCE = 96;

export function StartSpaceFab({ onPress }: { onPress: () => void }) {
  const theme = useHostTheme();
  const p = usePalette();
  return (
    <Host {...theme} matchContents style={styles.place}>
      <ExtendedFloatingActionButton
        expanded
        onClick={onPress}
        containerColor={p.accent}
        modifiers={[semantics({ contentDescription: 'Start a space' })]}
      >
        <ExtendedFloatingActionButton.Icon>
          <Icon
            source={require('../../assets/icons/add.xml')}
            tint={p.onAccent}
          />
        </ExtendedFloatingActionButton.Icon>
        <ExtendedFloatingActionButton.Text>
          <Text color={p.onAccent}>Start a space</Text>
        </ExtendedFloatingActionButton.Text>
      </ExtendedFloatingActionButton>
    </Host>
  );
}

const styles = StyleSheet.create({
  place: { position: 'absolute', right: 16, bottom: 16 },
});
