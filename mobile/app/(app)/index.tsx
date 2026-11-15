/**
 * Spaces: the fleet's spaces you started from here or follow. Waiting for an
 * answer first, then running, then the rest. Pull to refresh reconnects.
 */
import { useCallback, useMemo, useState } from 'react';
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { router, type Href } from 'expo-router';
import { useServices } from '../../src/services';
import { useFleetState } from '../../src/state/fleet';
import type { SpaceView } from '../../src/fleet/types';
import { ConnectionBanner } from '../../src/ui/ConnectionBanner';
import { Badge, Button, Card, Empty } from '../../src/ui/kit';
import {
  MODE_LABEL,
  STATUS_LABEL,
  STATUS_TONE,
  plainExcerpt,
  sortSpaces,
  spaceTitle,
} from '../../src/ui/logic';
import { usePalette } from '../../src/ui/theme';

const openSpace = (id: string) => router.push(`/space/${id}` as Href);
const openStart = () => router.push('/start' as Href);

function SpaceRow({ space }: { space: SpaceView }) {
  const p = usePalette();
  const excerpt = plainExcerpt(space.lastReply);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${spaceTitle(space)} on ${space.hostName}, ${STATUS_LABEL[space.status]}`}
      onPress={() => openSpace(space.space)}
      style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
    >
      <Card
        style={
          space.status === 'waiting' ? { borderColor: p.warning } : undefined
        }
      >
        <View style={styles.rowTop}>
          <Text numberOfLines={1} style={[styles.title, { color: p.text }]}>
            {spaceTitle(space)}
          </Text>
          <Badge
            label={STATUS_LABEL[space.status]}
            tone={STATUS_TONE[space.status]}
          />
        </View>
        <Text numberOfLines={1} style={[styles.meta, { color: p.muted }]}>
          {space.hostName} · {space.projectName} · {MODE_LABEL[space.mode]}
        </Text>
        {space.error ? (
          <Text numberOfLines={2} style={[styles.excerpt, { color: p.danger }]}>
            {space.error}
          </Text>
        ) : excerpt ? (
          <Text numberOfLines={2} style={[styles.excerpt, { color: p.text }]}>
            {excerpt}
          </Text>
        ) : null}
      </Card>
    </Pressable>
  );
}

export default function SpacesScreen() {
  const { fleet } = useServices();
  const spaces = useFleetState((s) => s.spaces);
  const sorted = useMemo(() => sortSpaces(spaces), [spaces]);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(() => {
    setRefreshing(true);
    fleet
      .start()
      .catch(() => {
        // the connection banner says why
      })
      .finally(() => setRefreshing(false));
  }, [fleet]);

  return (
    <FlatList
      data={sorted}
      keyExtractor={(s) => s.space}
      renderItem={({ item }) => <SpaceRow space={item} />}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={refresh} />
      }
      ListHeaderComponent={
        <View style={styles.header}>
          <ConnectionBanner />
          {sorted.length > 0 ? (
            <Button label="Start a space" kind="primary" onPress={openStart} />
          ) : null}
        </View>
      }
      ListEmptyComponent={
        <Empty
          title="No spaces yet"
          hint="Start one on a computer you trust, and follow it from here."
        >
          <Button label="Start a space" kind="primary" onPress={openStart} />
        </Empty>
      }
    />
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 10, flexGrow: 1 },
  header: { gap: 10 },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { flex: 1, fontSize: 17, fontWeight: '600' },
  meta: { fontSize: 13 },
  excerpt: { fontSize: 14, lineHeight: 19 },
});
