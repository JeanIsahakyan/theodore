/**
 * The desktop app's chrome around a product mock: the tab bar (ui/src/ui/
 * TabBar.tsx), an optional sidebar (Sidebar.tsx) and the page. Everything in
 * it is real UI built from the app's classes and components, not a picture.
 */
import type { ReactNode } from 'react';

export function Window({
  tab,
  tabIcon,
  sidebar,
  children,
  className = '',
  label,
}: {
  tab: string;
  tabIcon?: ReactNode;
  sidebar?: ReactNode;
  children: ReactNode;
  className?: string;
  /** For assistive tech: what this mock shows. */
  label: string;
}) {
  return (
    <div
      role="img"
      aria-label={label}
      className={`window flex flex-col overflow-hidden rounded-2xl border border-separator bg-background text-start shadow-[0_24px_60px_-30px_rgba(0,0,0,0.45)] ${className}`}
    >
      <div className="tabbar flex h-11 shrink-0 items-center gap-2 border-b border-separator ps-3 pe-3">
        <span className="me-1 flex gap-1.5" aria-hidden>
          <i className="size-2.5 rounded-full bg-default" />
          <i className="size-2.5 rounded-full bg-default" />
          <i className="size-2.5 rounded-full bg-default" />
        </span>
        <span className="tab inline-flex h-8 min-w-0 max-w-[70%] items-center gap-2 rounded-xl bg-default px-3 text-[13px]">
          {tabIcon && (
            <span className="grid size-4 shrink-0 place-items-center [&>svg]:size-4">
              {tabIcon}
            </span>
          )}
          <span className="min-w-0 truncate">{tab}</span>
        </span>
      </div>
      <div className="flex min-h-0 flex-1">
        {sidebar && (
          <aside className="sidebar hidden w-52 shrink-0 flex-col border-r border-separator md:flex">
            {sidebar}
          </aside>
        )}
        <div className="flex min-w-0 flex-1 flex-col">{children}</div>
      </div>
    </div>
  );
}

/** A page header inside the window (`space-header` in SpacePage.tsx). */
export function WindowHeader({
  title,
  chip,
  right,
}: {
  title: string;
  chip?: string;
  right?: ReactNode;
}) {
  return (
    <header className="flex min-h-12 shrink-0 items-center gap-2 border-b border-separator px-4 py-2">
      <span className="min-w-0 truncate text-sm font-semibold">{title}</span>
      {chip && (
        <span className="shrink-0 rounded-full bg-default px-2 py-0.5 text-xs">
          {chip}
        </span>
      )}
      {right && (
        <div className="ms-auto flex shrink-0 items-center gap-1.5">
          {right}
        </div>
      )}
    </header>
  );
}

/** A small action button as the app's `Btn` (tertiary / ghost). */
export function MockBtn({
  children,
  tone = 'tertiary',
  icon,
  className = '',
}: {
  children: ReactNode;
  tone?: 'primary' | 'tertiary' | 'ghost';
  icon?: ReactNode;
  className?: string;
}) {
  const cls =
    tone === 'primary'
      ? 'bg-accent text-accent-foreground'
      : tone === 'ghost'
        ? 'text-muted'
        : 'bg-default text-foreground';
  return (
    <span
      className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs font-medium ${cls} ${className} [&>svg]:size-3.5`}
    >
      {icon}
      {children}
    </span>
  );
}
