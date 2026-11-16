// Adapted from EvanBacon/chat-template (MIT)
/**
 * One icon name, the platform's own glyph:
 *
 * | Platform | Draws |
 * | --- | --- |
 * | iOS | SF Symbol (`expo-symbols`) |
 * | Android | Material Symbol (`expo-symbols`, Material 3's icon set) |
 * | web | Lucide (SVG, no icon font to load) |
 */
import { SymbolView } from 'expo-symbols';
import type { AndroidSymbol, SFSymbol } from 'expo-symbols';
import {
  ArrowUp,
  Bell,
  Bot,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  Circle,
  CircleAlert,
  CircleX,
  Ellipsis,
  FileText,
  Folder,
  Laptop,
  Menu,
  MessageSquare,
  MonitorSmartphone,
  Pencil,
  Plus,
  Puzzle,
  Search,
  Settings,
  SlidersHorizontal,
  Square,
  SquarePen,
  SquareTerminal,
  X,
  type LucideIcon,
} from 'lucide-react-native';
import type { StyleProp, ViewStyle } from 'react-native';

interface Glyph {
  sf: SFSymbol;
  md: AndroidSymbol;
  web: LucideIcon;
}

export const SYMBOLS = {
  'arrow.up': { sf: 'arrow.up', md: 'arrow_upward', web: ArrowUp },
  stop: { sf: 'stop.fill', md: 'stop', web: Square },
  'chevron.down': { sf: 'chevron.down', md: 'expand_more', web: ChevronDown },
  'chevron.up.chevron.down': {
    sf: 'chevron.up.chevron.down',
    md: 'unfold_more',
    web: ChevronsUpDown,
  },
  plus: { sf: 'plus', md: 'add', web: Plus },
  compose: { sf: 'square.and.pencil', md: 'edit_square', web: SquarePen },
  menu: { sf: 'line.3.horizontal', md: 'menu', web: Menu },
  bell: { sf: 'bell', md: 'notifications', web: Bell },
  settings: { sf: 'gearshape', md: 'settings', web: Settings },
  devices: {
    sf: 'laptopcomputer.and.iphone',
    md: 'devices',
    web: MonitorSmartphone,
  },
  computer: { sf: 'laptopcomputer', md: 'laptop_mac', web: Laptop },
  folder: { sf: 'folder', md: 'folder', web: Folder },
  agent: { sf: 'cpu', md: 'smart_toy', web: Bot },
  tune: { sf: 'slider.horizontal.3', md: 'tune', web: SlidersHorizontal },
  search: { sf: 'magnifyingglass', md: 'search', web: Search },
  check: { sf: 'checkmark', md: 'check', web: Check },
  close: { sf: 'xmark', md: 'close', web: X },
  clear: { sf: 'xmark.circle.fill', md: 'cancel', web: CircleX },
  chat: {
    sf: 'bubble.left.and.bubble.right',
    md: 'chat_bubble',
    web: MessageSquare,
  },
  'chevron.right': {
    sf: 'chevron.right',
    md: 'chevron_right',
    web: ChevronRight,
  },
  more: { sf: 'ellipsis', md: 'more_horiz', web: Ellipsis },
  // A space's steps, by kind of tool (src/ui/Timeline.tsx).
  'step.read': { sf: 'doc.text', md: 'description', web: FileText },
  'step.edit': { sf: 'pencil', md: 'edit', web: Pencil },
  'step.run': { sf: 'terminal', md: 'terminal', web: SquareTerminal },
  'step.search': { sf: 'magnifyingglass', md: 'search', web: Search },
  'step.agent': { sf: 'cpu', md: 'smart_toy', web: Bot },
  'step.mcp': { sf: 'puzzlepiece.extension', md: 'extension', web: Puzzle },
  'step.other': { sf: 'circle.fill', md: 'circle', web: Circle },
  'step.thinking': { sf: 'brain', md: 'psychology', web: Brain },
  'step.failed': {
    sf: 'exclamationmark.circle',
    md: 'error',
    web: CircleAlert,
  },
} as const satisfies Record<string, Glyph>;

export type SymbolName = keyof typeof SYMBOLS;

export function SymbolImage({
  name,
  size = 24,
  color,
  style,
  weight,
}: {
  name: SymbolName;
  size?: number;
  color: string;
  style?: StyleProp<ViewStyle>;
  /** iOS only: the SF Symbol's weight. */
  weight?: 'regular' | 'medium' | 'semibold' | 'bold';
}) {
  const g: Glyph = SYMBOLS[name];
  if (process.env.EXPO_OS === 'web') {
    const Web = g.web;
    return <Web size={size} color={color} style={style as never} />;
  }
  return (
    <SymbolView
      name={{ ios: g.sf, android: g.md }}
      size={size}
      tintColor={color}
      weight={weight}
      style={style}
    />
  );
}
