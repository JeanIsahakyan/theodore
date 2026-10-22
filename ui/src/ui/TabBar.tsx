import {
  BranchesRight,
  CodePullRequest,
  Gear,
  LayoutSideContentLeft,
  ListCheck,
  Link,
  Pencil,
  Plus,
  Sparkles,
  Tray,
  Xmark,
} from '@gravity-ui/icons';
import { Button, Tabs, Toolbar, Tooltip } from '@heroui/react';
import { observer } from 'mobx-react-lite';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useRootStore, useUi } from '../stores/context';
import type { Route } from '../stores/UiStore';
import { K } from './bits';
import { isBranchReview } from './project/sections';
import { PRIcon } from './StatusIcon';

function useLabel(r: Route): {
  icon: ReactNode;
  title: string;
  drafts?: number;
} {
  const store = useRootStore();
  switch (r.name) {
    case 'inbox':
      return { icon: <Tray />, title: 'Inbox' };
    case 'prs':
      return { icon: <CodePullRequest />, title: 'Pull requests' };
    case 'branches':
      return { icon: <BranchesRight />, title: 'Branches' };
    case 'tasks':
      return { icon: <ListCheck />, title: 'Tasks' };
    case 'skills':
      return { icon: <Sparkles />, title: 'Skills' };
    case 'settings':
      return { icon: <Gear />, title: 'Settings' };
    case 'new':
      return { icon: <Link />, title: 'New tab' };
    case 'space': {
      const s = store.models.spaces.get(r.id);
      return { icon: <Pencil />, title: s?.name ?? 'Space' };
    }
    case 'review': {
      const p = store.models.prSummaries.get(r.pr);
      const drafts = store.models.drafts.byPr(r.pr).length;
      return {
        icon: <PRIcon status={p?.state ?? 'open'} />,
        title: !p
          ? r.pr
          : isBranchReview(p)
            ? p.title
            : `#${p.pr.number} ${p.title}`,
        drafts,
      };
    }
  }
}

const key = (r: Route) => JSON.stringify(r);

/** Linear-style tabs: every opened PR stays one click away. */
export const TabBar = observer(function TabBar({
  showOpen,
}: {
  showOpen: boolean;
}) {
  const ui = useUi();
  const closable = ui.tabs.length > 1;
  const listRef = useRef<HTMLDivElement>(null);
  const selectedKey = key(ui.route);
  // Many tabs open + a short list width: keep the one you just switched to
  // in view instead of leaving it scrolled off either edge.
  useEffect(() => {
    const el = listRef.current?.querySelector(
      '[aria-selected="true"]',
    ) as HTMLElement | null;
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [selectedKey]);
  // Fade whichever edge has tabs scrolled out of view behind it.
  const [edges, setEdges] = useState({ left: false, right: false });
  useEffect(() => {
    const list =
      listRef.current?.querySelector<HTMLElement>('[role="tablist"]');
    if (!list) return;
    const update = () =>
      setEdges({
        left: list.scrollLeft > 1,
        right: list.scrollLeft + list.clientWidth < list.scrollWidth - 1,
      });
    update();
    list.addEventListener('scroll', update, { passive: true });
    const ro =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    ro?.observe(list);
    return () => {
      list.removeEventListener('scroll', update);
      ro?.disconnect();
    };
  }, [ui.tabs.length]);
  return (
    <Toolbar
      aria-label="Tabs"
      data-tauri-drag-region
      className={`tabbar flex h-12 w-full shrink-0 items-center gap-2 border-b border-separator bg-background px-3 ${showOpen ? 'ps-20' : ''}`}
    >
      {showOpen && (
        <Tooltip>
          <Button
            isIconOnly
            size="sm"
            variant="ghost"
            aria-label="Expand sidebar"
            onPress={() => ui.toggleSidebar()}
          >
            <LayoutSideContentLeft className="size-4" />
          </Button>
          <Tooltip.Content>
            Sidebar <K>[</K>
          </Tooltip.Content>
        </Tooltip>
      )}
      <Tabs
        selectedKey={selectedKey}
        onSelectionChange={(k) => {
          const t = ui.tabs.find((x) => key(x) === k);
          if (t) ui.go(t);
        }}
        className="min-w-0 shrink"
      >
        {/* `display: contents` — a plain ref anchor to query the selected
         *  tab from, without affecting the flex layout below it. */}
        <div ref={listRef} className="contents">
          <Tabs.List
            aria-label="Open tabs"
            className={`flex w-fit max-w-full overflow-x-auto scrollbar-none ${edges.left ? 'fade-l' : ''} ${edges.right ? 'fade-r' : ''}`}
          >
            {ui.tabs.map((t, i) => (
              <TabItem
                key={key(t)}
                t={t}
                i={i}
                closable={closable}
                onClose={() => ui.requestCloseTab(t)}
              />
            ))}
          </Tabs.List>
        </div>
      </Tabs>
      <span className="flex-1" />
      <Tooltip>
        <Button
          isIconOnly
          size="sm"
          variant="ghost"
          className="ms-1 shrink-0"
          aria-label="New tab"
          onPress={() => ui.newTab()}
        >
          <Plus className="size-4" />
        </Button>
        <Tooltip.Content>
          New tab — paste a PR link <K>⌘T</K>
        </Tooltip.Content>
      </Tooltip>
    </Toolbar>
  );
});

const TabItem = observer(function TabItem({
  t,
  i,
  closable,
  onClose,
}: {
  t: Route;
  i: number;
  closable: boolean;
  onClose: () => void;
}) {
  const l = useLabel(t);
  const ui = useUi();
  const closing = ui.closingTabs.includes(key(t));
  const anchor = useRef<HTMLSpanElement>(null);
  // Collapse from the tab's real width to 0: a CSS transition can't start
  // from `width: auto`, so pin the measured width first, then animate.
  useLayoutEffect(() => {
    const el = anchor.current?.closest<HTMLElement>('[role="tab"]');
    if (!closing || !el) return;
    el.style.width = `${el.offsetWidth}px`;
    void el.offsetWidth;
    el.classList.add('tab-closing');
  }, [closing]);
  return (
    <Tabs.Tab
      id={key(t)}
      // Tabs shrink to fit (title truncates); past their minimum the list scrolls.
      className="tab group w-auto min-w-28 max-w-64 shrink justify-start gap-2 px-3 text-sm"
    >
      {i > 0 && <Tabs.Separator />}
      <span
        ref={anchor}
        className="grid size-4 shrink-0 place-items-center [&>svg]:size-4"
      >
        {l.icon}
      </span>
      <span
        className="min-w-0 truncate"
        title={`${l.title}${i < 9 ? `  ⌥${i + 1}` : ''}`}
      >
        {l.title}
      </span>
      {!!l.drafts && (
        <span
          className="size-1.5 shrink-0 rounded-full bg-warning"
          aria-label={`${l.drafts} pending comments`}
        />
      )}
      {closable && (
        <Button
          isIconOnly
          size="sm"
          variant="ghost"
          aria-label="close tab"
          className="tab-x -me-1 ms-auto size-5 min-w-5 rounded-xl opacity-0 group-hover:opacity-100 group-data-[selected=true]:opacity-100"
          onPress={onClose}
        >
          <Xmark className="size-3.5" />
        </Button>
      )}
      <Tabs.Indicator />
    </Tabs.Tab>
  );
});
