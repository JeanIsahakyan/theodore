import { useEffect, useRef, useState, type Key, type ReactNode } from 'react';
import {
  EmptyState,
  Header,
  ListBox,
  Modal,
  ScrollShadow,
} from '@heroui/react';
import {
  Check,
  Clock,
  CodePullRequest,
  Gear,
  ListCheck,
  Moon,
  Tray,
} from '@gravity-ui/icons';
import { observer } from 'mobx-react-lite';
import type { SnoozeUntil } from '../gen/contract';
import { snoozePrs } from '../actions';
import { FEATURES } from '../features';
import { useRootStore, useUi } from '../stores/context';
import { toggleTheme } from '../stores/UiStore';
import { K } from './bits';

export interface Item {
  group?: string;
  label: string;
  icon?: ReactNode;
  sub?: string;
  keys?: string;
  run: () => void;
}

const sections = (shown: Item[]) => {
  const out: { group: string; items: { it: Item; n: number }[] }[] = [];
  shown.forEach((it, n) => {
    const g = it.group ?? '';
    if (out[out.length - 1]?.group !== g) out.push({ group: g, items: [] });
    out[out.length - 1]!.items.push({ it, n });
  });
  return out;
};

/** Linear's menu: type to filter, up/down + enter, digits pick when the query is empty. */
export function Palette({
  title,
  items,
  placeholder,
  digits,
  onClose,
}: {
  title?: string;
  items: Item[];
  placeholder: string;
  digits?: boolean;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const t = setTimeout(() => input.current?.focus(), 30);
    return () => clearTimeout(t);
  }, []);
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = items.filter((it) =>
    words.every((w) =>
      `${it.group ?? ''} ${it.label} ${it.sub ?? ''}`.toLowerCase().includes(w),
    ),
  );
  const runAt = (n: number) => {
    const it = shown[n];
    if (!it) return;
    onClose();
    it.run();
  };
  return (
    <Modal.Backdrop
      isOpen
      onOpenChange={(open) => !open && onClose()}
      variant="transparent"
      className="bg-black/20"
    >
      <Modal.Container size="lg" placement="top" className="mt-[10vh]">
        <Modal.Dialog
          aria-label={title ?? 'Commands'}
          className="palette overflow-hidden p-0"
        >
          {title && (
            <div className="pal-title px-4 pt-3 text-xs text-muted">
              {title}
            </div>
          )}
          <input
            ref={input}
            className="pal-input w-full border-b border-separator bg-transparent px-4 py-3.5 text-base outline-none placeholder:text-muted"
            placeholder={placeholder}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setI(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown')
                setI((x) => Math.min(shown.length - 1, x + 1));
              else if (e.key === 'ArrowUp') setI((x) => Math.max(0, x - 1));
              else if (e.key === 'Enter') runAt(i);
              else if (digits && !q && /^[1-9]$/.test(e.key))
                runAt(Number(e.key) - 1);
              else return;
              e.preventDefault();
            }}
          />
          <ScrollShadow className="max-h-[52vh] p-1.5" hideScrollBar>
            <ListBox
              aria-label={title ?? 'Commands'}
              selectionMode="none"
              onAction={(k: Key) => runAt(Number(k))}
              renderEmptyState={() => (
                <EmptyState className="px-3 py-4">No matches</EmptyState>
              )}
              className="p-0"
            >
              {sections(shown).map((sec) => (
                <ListBox.Section key={sec.group || '_'} id={sec.group || '_'}>
                  {sec.group && (
                    <Header className="pal-group px-2 pb-1 pt-2 text-xs text-muted">
                      {sec.group}
                    </Header>
                  )}
                  {sec.items.map(({ it, n }) => (
                    <ListBox.Item
                      key={n}
                      id={n}
                      textValue={it.label}
                      className={`pal-item h-9 gap-2.5 rounded-2xl px-2.5 ${n === i ? 'on bg-default' : ''}`}
                      onHoverStart={() => setI(n)}
                    >
                      <span className="grid w-[18px] place-items-center text-muted">
                        {it.icon}
                      </span>
                      <span>{it.label}</span>
                      {it.sub && (
                        <span className="text-xs text-muted">{it.sub}</span>
                      )}
                      <span className="flex-1" />
                      {digits && n < 9 && !q ? (
                        <K>{n + 1}</K>
                      ) : (
                        it.keys && <K>{it.keys}</K>
                      )}
                    </ListBox.Item>
                  ))}
                </ListBox.Section>
              ))}
            </ListBox>
          </ScrollShadow>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

const SNOOZE_LABEL: Record<SnoozeUntil['kind'], string> = {
  time: 'for 1 hour',
  next_push: 'until next push',
  checks_green: 'until checks pass',
};

export const SnoozeMenu = observer(function SnoozeMenu() {
  const store = useRootStore();
  const ui = useUi();
  const targets = ui.snoozeTargets;
  const opts: SnoozeUntil[] = [
    { kind: 'time', at: Date.now() + 3600_000 },
    { kind: 'next_push' },
    { kind: 'checks_green' },
  ];
  return (
    <Palette
      title={`Snooze · ${targets.length === 1 ? targets[0] : `${targets.length} PR`}`}
      placeholder="Snooze until…"
      digits
      onClose={() => ui.closeModal()}
      items={opts.map((o) => ({
        label: SNOOZE_LABEL[o.kind],
        icon: <Clock />,
        sub: o.kind !== 'time' ? 'wakes on a GitHub event' : undefined,
        run: () => snoozePrs(store, targets, o),
      }))}
    />
  );
});

export const CommandMenu = observer(function CommandMenu() {
  const ui = useUi();
  const items: Item[] = [
    {
      group: 'Go to',
      label: 'Inbox',
      icon: <Tray />,
      keys: 'G I',
      run: () => ui.go({ name: 'inbox' }),
    },
    ...(FEATURES.currentUser
      ? [
          {
            group: 'Go to',
            label: 'My PRs',
            icon: <CodePullRequest />,
            keys: 'G M',
            run: () => ui.go({ name: 'mine' }),
          },
        ]
      : []),
    {
      group: 'Go to',
      label: 'Tasks',
      icon: <ListCheck />,
      keys: 'G T',
      run: () => ui.go({ name: 'tasks' }),
    },
    {
      group: 'Go to',
      label: 'Settings',
      icon: <Gear />,
      keys: 'G S',
      run: () => ui.go({ name: 'settings', page: 'agents' }),
    },
    {
      group: 'General',
      label: 'Light / dark theme',
      icon: <Moon />,
      run: toggleTheme,
    },
    {
      group: 'General',
      label: 'Collapse / expand sidebar',
      icon: <Check />,
      keys: '[',
      run: () => ui.toggleSidebar(),
    },
  ];
  return (
    <Palette
      items={items}
      placeholder="Command or action…"
      onClose={() => ui.closeModal()}
    />
  );
});

let gAt = 0;
/** True right after `g` — the next key belongs to a g-sequence, not a view shortcut. */
export const inSequence = () => Date.now() - gAt < 900;

/** Linear-style key sequences and global shortcuts, in the capture phase so they win. */
export function useGlobalKeys() {
  const store = useRootStore();
  const ui = useUi();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        if (ui.modal === 'cmdk') ui.closeModal();
        else ui.openModal('cmdk');
      } else if (
        (e.metaKey || e.ctrlKey) &&
        e.key.toLowerCase() === 'z' &&
        !(e.target as HTMLElement).closest('input,textarea')
      ) {
        if (e.shiftKey) void store.sync.undo.redo();
        else void store.sync.undo.undo();
      } else if (e.altKey && e.code === 'KeyW' && !ui.modal) {
        ui.closeTab(ui.route);
      } else if (e.altKey && /^Digit[1-9]$/.test(e.code) && !ui.modal) {
        ui.switchTab(Number(e.code.slice(5)) - 1);
      } else if (
        ui.modal ||
        e.metaKey ||
        e.ctrlKey ||
        (e.target as HTMLElement).closest('input,textarea,select')
      ) {
        return;
      } else if (inSequence() && /^[itsam]$/.test(e.key)) {
        gAt = 0;
        if (e.key === 'i') ui.go({ name: 'inbox' });
        if (e.key === 't') ui.go({ name: 'tasks' });
        if (e.key === 's') ui.go({ name: 'settings', page: 'agents' });
        if (e.key === 'm' && FEATURES.currentUser) ui.go({ name: 'mine' });
      } else if (e.key === 'g') {
        gAt = Date.now();
      } else if (e.key === '[') {
        ui.toggleSidebar();
      } else if (e.key === ']' && ui.route.name === 'review') {
        ui.toggleAside();
      } else {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [store, ui]);
}
