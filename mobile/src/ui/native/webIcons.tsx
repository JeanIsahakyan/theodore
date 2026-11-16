/** Web: the kit's icons as Lucide glyphs (SVG). Imported only by web files. */
import {
  BadgeCheck,
  Bell,
  Building2,
  Fingerprint,
  Globe,
  Info,
  Mail,
  Monitor,
  RadioTower,
  Server,
  Smartphone,
  SunMoon,
  User,
  type LucideIcon,
} from 'lucide-react-native';
import type { IconName } from './icons';

const LUCIDE: Record<IconName, LucideIcon> = {
  theme: SunMoon,
  email: Mail,
  person: User,
  organization: Building2,
  phone: Smartphone,
  status: RadioTower,
  notifications: Bell,
  info: Info,
  server: Server,
  computer: Monitor,
  globe: Globe,
  fingerprint: Fingerprint,
  trusted: BadgeCheck,
};

export function WebIcon({
  name,
  color,
  size = 20,
}: {
  name: IconName;
  color: string;
  size?: number;
}) {
  const Glyph = LUCIDE[name];
  return <Glyph size={size} color={color} />;
}
