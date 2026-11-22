/**
 * A space's header: the main header (☰, questions, new space), the
 * space's name and "on <host> · <status>" under it. A space is a
 * top-level screen like Home: no Back, the drawer is how you leave it.
 * Archive is in the drawer row's long-press menu, not here: the title
 * keeps its room.
 */
import type { SpaceHeaderProps } from './space-title';
import { MainHeader } from './main-header';

export function SpaceHeader({ title, subtitle }: SpaceHeaderProps) {
  return <MainHeader title={title} subtitle={subtitle} />;
}
