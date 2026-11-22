/** A phone frame for the hero demo and the mobile mock. */
import type { ReactNode } from 'react';

export function Phone({
  children,
  className = '',
  label,
}: {
  children: ReactNode;
  className?: string;
  label: string;
}) {
  return (
    <div
      role="img"
      aria-label={label}
      className={`phone relative mx-auto flex h-[480px] w-[236px] shrink-0 flex-col overflow-hidden rounded-[38px] border border-separator bg-background p-3 pt-11 shadow-[0_30px_60px_-30px_rgba(0,0,0,0.5)] ${className}`}
    >
      <span
        aria-hidden
        className="absolute left-1/2 top-3 h-6 w-20 -translate-x-1/2 rounded-full bg-default"
      />
      {children}
    </div>
  );
}
