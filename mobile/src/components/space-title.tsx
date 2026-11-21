// Adapted from EvanBacon/chat-template (MIT)
/**
 * A space's title in the main header: the name on one line, cut with "…",
 * and a muted line under it ("on mac-A · Running"); centered on iOS, at
 * the start on web.
 */
import { Platform, Text, View } from 'react-native';
import { usePalette } from '../ui/theme';

export interface SpaceHeaderProps {
  title: string;
  subtitle: string;
}

const centered = Platform.OS === 'ios';

export function TitleStack({
  title,
  subtitle,
  maxWidth,
  align = 'center',
}: SpaceHeaderProps & { maxWidth?: number; align?: 'center' | 'start' }) {
  const p = usePalette();
  const items = align === 'center' ? 'items-center' : 'items-start';
  return (
    <View
      accessible
      accessibilityRole="header"
      accessibilityLabel={`${title}, ${subtitle}`}
      className={`min-w-0 ${items}`}
      style={maxWidth ? { maxWidth } : null}
    >
      <Text
        numberOfLines={1}
        style={{
          color: p.text,
          fontSize: centered ? 17 : 18,
          fontWeight: centered ? '600' : '500',
        }}
      >
        {title}
      </Text>
      <Text numberOfLines={1} style={{ color: p.muted, fontSize: 12 }}>
        {subtitle}
      </Text>
    </View>
  );
}
