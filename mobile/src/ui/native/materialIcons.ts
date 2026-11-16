/**
 * Android: the kit's icons as Material Symbols (outlined, 24 dp vector
 * drawables from google/material-design-icons, in `assets/icons`), drawn
 * by Compose's `Icon`. Imported only by `*.android.tsx`.
 */
import type { ImageSourcePropType } from 'react-native';
import type { IconName } from './icons';

export const MATERIAL: Record<IconName, ImageSourcePropType> = {
  theme: require('../../../assets/icons/contrast.xml'),
  email: require('../../../assets/icons/mail.xml'),
  person: require('../../../assets/icons/person.xml'),
  organization: require('../../../assets/icons/corporate_fare.xml'),
  phone: require('../../../assets/icons/smartphone.xml'),
  status: require('../../../assets/icons/sensors.xml'),
  notifications: require('../../../assets/icons/notifications.xml'),
  info: require('../../../assets/icons/info.xml'),
  server: require('../../../assets/icons/dns.xml'),
  computer: require('../../../assets/icons/computer.xml'),
  globe: require('../../../assets/icons/language.xml'),
  fingerprint: require('../../../assets/icons/fingerprint.xml'),
  trusted: require('../../../assets/icons/verified.xml'),
};
