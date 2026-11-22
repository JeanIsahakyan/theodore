/**
 * A space's header: the main header (☰, questions, new space), the
 * space's name and "on <host> · <status>" under it. A space is a
 * top-level screen like Home: no Back, the drawer is how you leave it.
 */
import type { HeaderMenuItem } from './header-actions';
import type { SpaceHeaderProps } from './space-title';
import { MainHeader } from './main-header';

export function SpaceHeader({
  title,
  subtitle,
  menu,
}: SpaceHeaderProps & { menu?: HeaderMenuItem[] }) {
  return <MainHeader title={title} subtitle={subtitle} menu={menu} />;
}
