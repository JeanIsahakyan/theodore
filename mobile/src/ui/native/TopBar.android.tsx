/**
 * Android: a Material 3 small top app bar (Compose `TopAppBar`): the back
 * arrow (`IconButton`, read "Back"), the title in `titleLarge`, cut with
 * "…", and the action. The bar sits under the status bar: React Native
 * pads it, so Compose adds no window insets of its own.
 *
 * ```text
 * [←][Title, left-aligned…            ][Action]
 * ```
 *
 * The action is a kit control rendered bare inside this `Host` (`InHost`).
 */
import {
  Host,
  Icon,
  IconButton,
  Text,
  TopAppBar,
} from '@expo/ui/jetpack-compose';
import { semantics } from '@expo/ui/jetpack-compose/modifiers';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { usePalette } from '../theme';
import { InHost } from './context';
import { useHostTheme } from './host.android';
import type { TopBarProps } from './types';

const NO_INSETS = {};

export function TopBar({ title, onBack, action }: TopBarProps) {
  const p = usePalette();
  const theme = useHostTheme();
  const insets = useSafeAreaInsets();
  return (
    <View
      style={{
        paddingTop: insets.top,
        paddingLeft: insets.left,
        paddingRight: insets.right,
        backgroundColor: p.background,
      }}
    >
      <Host {...theme} matchContents={{ vertical: true }}>
        <InHost.Provider value>
          <TopAppBar
            windowInsets={NO_INSETS}
            colors={{
              containerColor: p.background,
              titleContentColor: p.text,
              navigationIconContentColor: p.text,
              actionIconContentColor: p.accent,
            }}
          >
            <TopAppBar.Title>
              <Text
                maxLines={1}
                overflow="ellipsis"
                style={{ typography: 'titleLarge' }}
              >
                {title}
              </Text>
            </TopAppBar.Title>
            {onBack ? (
              <TopAppBar.NavigationIcon>
                <IconButton
                  onClick={onBack}
                  modifiers={[semantics({ contentDescription: 'Back' })]}
                >
                  <Icon
                    source={require('../../../assets/icons/arrow_back.xml')}
                  />
                </IconButton>
              </TopAppBar.NavigationIcon>
            ) : null}
            {action ? <TopAppBar.Actions>{action}</TopAppBar.Actions> : null}
          </TopAppBar>
        </InHost.Provider>
      </Host>
    </View>
  );
}
