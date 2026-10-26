/**
 * The app's one custom context menu, replacing the webview's native one
 * everywhere (`main.tsx` suppresses `contextmenu` globally). Opens at the
 * pointer via a zero-size anchor positioned by `UiStore.contextMenu`; same
 * HeroUI Dropdown/Menu primitives as every other menu in the app, so it looks
 * and navigates like one.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type Key,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { Dropdown } from '@heroui/react';
import { observer } from 'mobx-react-lite';
import { useUi } from '../stores/context';
import type { UiStore } from '../stores/UiStore';

export interface ContextMenuItem {
  id: string;
  label: ReactNode;
  /** Plain-text label for accessibility when `label` isn't a string. */
  textValue?: string;
  icon?: ReactNode;
  kbd?: string;
  danger?: boolean;
  isDisabled?: boolean;
  /** Shown as a native tooltip (`title`) on a disabled item. */
  disabledReason?: string;
  onAction?: () => void;
  /** A submenu, e.g. Snooze ▸ 1h / tomorrow / until push / until checks green. */
  items?: ContextMenuItem[];
}

function labelText(it: ContextMenuItem): string {
  return it.textValue ?? (typeof it.label === 'string' ? it.label : it.id);
}

function flatten(
  items: ContextMenuItem[],
  out: Map<string, ContextMenuItem>,
): void {
  for (const it of items) {
    out.set(it.id, it);
    if (it.items) flatten(it.items, out);
  }
}

function MenuItems({ items }: { items: ContextMenuItem[] }) {
  return (
    <>
      {items.map((it) =>
        it.items ? (
          <Dropdown.SubmenuTrigger key={it.id}>
            <Dropdown.Item
              id={it.id}
              textValue={labelText(it)}
              className="max-w-[320px] gap-2"
            >
              {it.icon}
              <span className="min-w-0 flex-1 truncate">{it.label}</span>
              <Dropdown.SubmenuIndicator />
            </Dropdown.Item>
            <Dropdown.Popover placement="right top">
              <Dropdown.Menu aria-label={labelText(it)}>
                <MenuItems items={it.items} />
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown.SubmenuTrigger>
        ) : (
          <Dropdown.Item
            key={it.id}
            id={it.id}
            textValue={labelText(it)}
            isDisabled={it.isDisabled}
            className={`max-w-[320px] gap-2 ${it.danger ? 'text-danger' : ''}`}
          >
            {it.icon}
            <span className="min-w-0 flex-1 truncate">{it.label}</span>
            {it.isDisabled ? (
              <span className="ms-2 shrink-0 text-xs text-muted">
                {it.disabledReason ?? 'Not available yet'}
              </span>
            ) : (
              it.kbd && (
                <span className="ms-2 shrink-0 text-xs text-muted">
                  {it.kbd}
                </span>
              )
            )}
          </Dropdown.Item>
        ),
      )}
    </>
  );
}

/** Mounted once in `App`. Esc / outside click close it like any overlay; a
 *  capture-phase scroll listener closes it too, since its anchor is a fixed
 *  point that doesn't move with whatever scrolled under the pointer. */
export const ContextMenuHost = observer(function ContextMenuHost() {
  const ui = useUi();
  const anchorRef = useRef<HTMLDivElement>(null);
  const menu = ui.contextMenu;

  useEffect(() => {
    if (!menu) return;
    const close = () => ui.closeContextMenu();
    window.addEventListener('scroll', close, true);
    return () => window.removeEventListener('scroll', close, true);
  }, [menu, ui]);

  const registry = useMemo(() => {
    const m = new Map<string, ContextMenuItem>();
    if (menu) flatten(menu.items, m);
    return m;
  }, [menu]);

  const onAction = useCallback(
    (k: Key) => {
      registry.get(String(k))?.onAction?.();
    },
    [registry],
  );

  return (
    <>
      <div
        ref={anchorRef}
        aria-hidden
        style={{
          position: 'fixed',
          left: menu?.x ?? 0,
          top: menu?.y ?? 0,
          width: 0,
          height: 0,
        }}
      />
      {menu && (
        <Dropdown
          isOpen
          onOpenChange={(open) => !open && ui.closeContextMenu()}
        >
          <Dropdown.Popover triggerRef={anchorRef} placement="bottom start">
            <Dropdown.Menu aria-label="Context menu" onAction={onAction}>
              <MenuItems items={menu.items} />
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
      )}
    </>
  );
});

/**
 * The non-hook core: build an `onContextMenu` handler from a `UiStore`
 * instance directly. Use this (not `useContextMenu`) for a menu built inside
 * a list's `.map()` — hooks can't be called per-iteration there.
 */
export function contextMenuHandler(
  ui: UiStore,
  items: ContextMenuItem[] | (() => ContextMenuItem[]),
) {
  return (e: ReactMouseEvent) => {
    if (import.meta.env.DEV && e.altKey) return;
    e.preventDefault();
    e.stopPropagation();
    const resolved = typeof items === 'function' ? items() : items;
    if (resolved.length) ui.openContextMenu(e.clientX, e.clientY, resolved);
  };
}

/**
 * Attach the returned handler to any element's `onContextMenu`. In dev,
 * ⌥+right-click is left alone so it still opens the webview devtools; `items`
 * may be a fixed array or computed lazily (so it can read fresh state at
 * open time, e.g. the hunk under the pointer). For a menu built per-row
 * inside a `.map()`, use `contextMenuHandler` instead.
 */
export function useContextMenu(
  items: ContextMenuItem[] | (() => ContextMenuItem[]),
) {
  const ui = useUi();
  return useCallback(
    (e: ReactMouseEvent) => {
      if (import.meta.env.DEV && e.altKey) return;
      e.preventDefault();
      e.stopPropagation();
      const resolved = typeof items === 'function' ? items() : items;
      if (resolved.length) ui.openContextMenu(e.clientX, e.clientY, resolved);
    },
    [items, ui],
  );
}
