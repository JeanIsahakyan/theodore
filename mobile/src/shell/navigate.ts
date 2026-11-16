/**
 * Moving around from the drawer and the header. The signed-in stack keeps
 * at most one screen over Home (`/`, the new-space screen, its anchor):
 *
 * ```text
 * drawer pick on Home        ─▶ push      [Home, pick]
 * drawer pick anywhere else  ─▶ replace   [Home, pick]   (back: Home)
 * new space                  ─▶ dismissTo [Home], its goal cleared and focused
 * notification / deep link   ─▶ push      [Home, space]  (Home is the anchor)
 * ```
 */
import { router, type Href } from 'expo-router';
import { requestNewSpace } from '../state/compose';

/** `/space/<id>` of a space. */
export const spaceHref = (id: string): Href =>
  `/space/${encodeURIComponent(id)}` as Href;

export function openFromDrawer(href: Href, path: string): void {
  if (path === href) return;
  if (path === '/') router.push(href);
  else router.replace(href, { withAnchor: true });
}

export function goNewSpace(path: string): void {
  requestNewSpace();
  if (path === '/') return;
  if (router.canDismiss()) router.dismissTo('/' as Href);
  else router.replace('/' as Href);
}
