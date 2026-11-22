/**
 * `/s/<id>`: a space link (docs/mobile.md "Space links"), the path a
 * Universal Link / App Link `https://theodore.cloud/s/<id>` and the web
 * app's own address carry. Resolves the id (`src/shell/spaceLink.ts`) and
 * replaces itself with the space's screen; a space not followed here says
 * so instead of crashing or showing an empty chat.
 */
import { Redirect, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { MainHeader } from '../../../src/components/main-header';
import { useGlassHeaderInset } from '../../../src/shell/glassHeader';
import { backHome, spaceHref } from '../../../src/shell/navigate';
import {
  LOOKING,
  LOOKING_MS,
  NOT_ON_DEVICES,
  resolveSpaceLink,
  spaceLinkState,
} from '../../../src/shell/spaceLink';
import { useFleetState } from '../../../src/state/fleet';
import { Empty } from '../../../src/ui/kit';
import { Button } from '../../../src/ui/native';
import { usePalette } from '../../../src/ui/theme';

export default function SpaceLinkScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const p = usePalette();
  const top = useGlassHeaderInset();
  const spaces = useFleetState((s) => s.spaces);
  const mirrors = useFleetState((s) => s.mirrors);
  const welcomed = useFleetState((s) => s.welcomed);
  const [waited, setWaited] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => setWaited(LOOKING_MS), LOOKING_MS);
    return () => clearTimeout(t);
  }, []);

  const link = resolveSpaceLink(id ?? '', spaces, mirrors);
  const state = spaceLinkState(link, welcomed, waited);
  if (link.kind === 'found') return <Redirect href={spaceHref(link.space)} />;
  return (
    <View style={{ paddingTop: top }}>
      <MainHeader title="Space" />
      {state === 'looking' ? (
        <Empty title={LOOKING}>
          <ActivityIndicator
            accessibilityLabel={LOOKING}
            color={p.muted}
            style={{ marginTop: 12 }}
          />
        </Empty>
      ) : (
        <Empty title={NOT_ON_DEVICES.title} hint={NOT_ON_DEVICES.hint}>
          <View style={{ marginTop: 16 }}>
            <Button label="Home" onPress={backHome} testID="space-link-home" />
          </View>
        </Empty>
      )}
    </View>
  );
}
