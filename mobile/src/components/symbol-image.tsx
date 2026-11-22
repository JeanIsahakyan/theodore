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
  Archive,
  ArrowUp,
  ArrowUpDown,
  BadgeCheck,
  Download,
  Paperclip,
  RotateCw,
  Share,
  Bell,
  Bot,
  Brain,
  Bug,
  Building,
  ChartColumn,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  Circle,
  CircleAlert,
  CircleX,
  CloudOff,
  Copy,
  Ellipsis,
  FileText,
  FingerprintPattern,
  Folder,
  Globe,
  Info,
  Laptop,
  LogOut,
  UserX,
  Menu,
  MessageSquare,
  MonitorSmartphone,
  Pencil,
  Plus,
  Puzzle,
  ScrollText,
  Search,
  Server,
  Settings,
  SlidersHorizontal,
  Smartphone,
  Square,
  SquarePen,
  SquareTerminal,
  SunMoon,
  UserPlus,
  Users,
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
  /** Archive a space (the drawer row's menu, src/components/space-menu*). */
  archive: { sf: 'archivebox', md: 'archive', web: Archive },
  // Files (src/components/chat/attach-button.tsx, app/(app)/file/[space].tsx).
  attach: { sf: 'paperclip', md: 'attach_file', web: Paperclip },
  retry: { sf: 'arrow.clockwise', md: 'refresh', web: RotateCw },
  share: { sf: 'square.and.arrow.up', md: 'share', web: Share },
  download: { sf: 'arrow.down.circle', md: 'download', web: Download },
  // Settings and Devices (src/components/settings/).
  organization: { sf: 'building.2', md: 'corporate_fare', web: Building },
  accounts: { sf: 'person.2', md: 'group', web: Users },
  'add-account': { sf: 'person.badge.plus', md: 'person_add', web: UserPlus },
  switch: { sf: 'arrow.up.arrow.down', md: 'swap_vert', web: ArrowUpDown },
  phone: { sf: 'iphone', md: 'smartphone', web: Smartphone },
  server: { sf: 'server.rack', md: 'dns', web: Server },
  globe: { sf: 'globe', md: 'language', web: Globe },
  appearance: { sf: 'circle.lefthalf.filled', md: 'contrast', web: SunMoon },
  info: { sf: 'info.circle', md: 'info', web: Info },
  'sign-out': {
    sf: 'rectangle.portrait.and.arrow.right',
    md: 'logout',
    web: LogOut,
  },
  'delete-account': {
    sf: 'person.crop.circle.badge.xmark',
    md: 'person_remove',
    web: UserX,
  },
  copy: { sf: 'doc.on.doc', md: 'content_copy', web: Copy },
  fingerprint: { sf: 'touchid', md: 'fingerprint', web: FingerprintPattern },
  trusted: { sf: 'checkmark.seal.fill', md: 'verified', web: BadgeCheck },
  offline: { sf: 'icloud.slash', md: 'cloud_off', web: CloudOff },
  // Privacy and diagnostics (docs/telemetry.md "Mobile").
  chart: { sf: 'chart.bar', md: 'bar_chart', web: ChartColumn },
  warning: { sf: 'ladybug', md: 'bug_report', web: Bug },
  list: { sf: 'list.bullet.rectangle', md: 'list_alt', web: ScrollText },
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
