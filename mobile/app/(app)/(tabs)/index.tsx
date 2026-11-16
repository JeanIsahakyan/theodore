/**
 * Spaces: the fleet's spaces you started from here or follow. Waiting for an
 * answer first, then running, then the rest. Pull to refresh reconnects.
 *
 * ```text
 *            list                                   "Start a space"
 * iOS        inset grouped rows (src/ui/SpaceRow)   "+" in the header (a bar button)
 * Android    Material 3 segmented rows              extended FAB, bottom-right
 * web        inset grouped rows                     button above the list
 * empty      symbol, "No spaces yet", hint, "Start a space" button (all)
 * ```
 *
 * The header belongs to the stack around the tabs (`../_layout.tsx`): the
 * "+" is set on it while this tab is focused and taken off on blur.
 */
import { SymbolView } from 'expo-symbols';
import { router, useFocusEffect, useNavigation, type Href } from 'expo-router';
import type { NativeStackNavigationOptions } from 'expo-router/native-stack';
import { useCallback, useMemo, useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useServices } from '../../../src/services';
import { useFleetState } from '../../../src/state/fleet';
import { ConnectionBanner } from '../../../src/ui/ConnectionBanner';
import { sortSpaces } from '../../../src/ui/logic';
import { Button } from '../../../src/ui/native';
import { SpaceRow, SpaceRowSeparator } from '../../../src/ui/SpaceRow';
import { FAB_CLEARANCE, StartSpaceFab } from '../../../src/ui/StartSpaceFab';
import { usePalette } from '../../../src/ui/theme';

const openSpace = (id: string) => router.push(`/space/${id}` as Href);
const openStart = () => router.push('/start' as Href);

const ios = process.env.EXPO_OS === 'ios';
const web = process.env.EXPO_OS === 'web';

/** iOS: a "+" bar button on the stack's header while Spaces is in front. */
function useStartInHeader() {
  const navigation = useNavigation();
  useFocusEffect(
    useCallback(() => {
      if (!ios) return undefined;
      const stack = navigation.getParent();
      const set = (o: NativeStackNavigationOptions) => stack?.setOptions(o);
      set({
        unstable_headerRightItems: () => [
          {
            type: 'button',
            label: 'Start a space',
            accessibilityLabel: 'Start a space',
            icon: { type: 'sfSymbol', name: 'plus' },
            onPress: openStart,
          },
        ],
      });
      return () => set({ unstable_headerRightItems: undefined });
    }, [navigation]),
  );
}

function EmptySpaces() {
  const p = usePalette();
  return (
    <View style={styles.empty}>
      {web ? null : (
        <SymbolView
          name={{ ios: 'rectangle.stack', android: 'stacks' }}
          size={48}
          weight="light"
          tintColor={p.muted}
          style={styles.emptySymbol}
        />
      )}
      <Text
        accessibilityRole="header"
        style={[styles.emptyTitle, { color: p.text }]}
      >
        No spaces yet
      </Text>
      <Text style={[styles.emptyHint, { color: p.muted }]}>
        Start one on a computer you trust, and follow it from here.
      </Text>
      <Button
        label="Start a space"
        variant="primary"
        onPress={openStart}
        style={styles.emptyAction}
      />
    </View>
  );
}

export default function SpacesScreen() {
  const p = usePalette();
  const { fleet } = useServices();
  const spaces = useFleetState((s) => s.spaces);
  const sorted = useMemo(() => sortSpaces(spaces), [spaces]);
  const [refreshing, setRefreshing] = useState(false);
  useStartInHeader();

  const refresh = useCallback(() => {
    setRefreshing(true);
    fleet
      .start()
      .catch(() => {
        // the connection banner says why
      })
      .finally(() => setRefreshing(false));
  }, [fleet]);

  const last = sorted.length - 1;
  const any = sorted.length > 0;

  return (
    <View style={[styles.root, { backgroundColor: p.background }]}>
      <FlatList
        data={sorted}
        keyExtractor={(s) => s.space}
        renderItem={({ item, index }) => (
          <SpaceRow
            space={item}
            first={index === 0}
            last={index === last}
            onPress={() => openSpace(item.space)}
          />
        )}
        ItemSeparatorComponent={SpaceRowSeparator}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[
          styles.content,
          any && FAB_CLEARANCE ? { paddingBottom: FAB_CLEARANCE } : null,
        ]}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={refresh}
            tintColor={p.muted}
            colors={[p.accent]}
          />
        }
        ListHeaderComponent={
          <View style={styles.header}>
            <ConnectionBanner />
            {web && any ? (
              <Button
                label="Start a space"
                variant="primary"
                onPress={openStart}
              />
            ) : null}
          </View>
        }
        ListEmptyComponent={EmptySpaces}
      />
      {any ? <StartSpaceFab onPress={openStart} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 24,
    flexGrow: 1,
    width: '100%',
    maxWidth: 720,
    alignSelf: 'center',
  },
  header: { gap: 10, paddingBottom: 12, alignItems: 'stretch' },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingBottom: 48,
    gap: 8,
  },
  emptySymbol: { width: 48, height: 48, marginBottom: 8 },
  emptyTitle: { fontSize: 22, fontWeight: '700', textAlign: 'center' },
  emptyHint: {
    fontSize: 15,
    lineHeight: 21,
    textAlign: 'center',
    maxWidth: 320,
  },
  emptyAction: { marginTop: 12 },
});
