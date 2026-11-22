/** A phone frame for the hero demo and the phone mock. */
import type { ReactNode } from 'react';

export function Phone({
  children,
  className = '',
  label,
  size = 'md',
  ...rest
}: {
  children: ReactNode;
  className?: string;
  label: string;
  /** `sm` for the hero, where it sits beside the computer. */
  size?: 'sm' | 'md';
  'data-buzz'?: boolean;
}) {
  const dims =
    size === 'sm'
      ? 'h-[400px] w-[206px] rounded-[34px] p-2.5 pt-9'
      : 'h-[520px] w-[250px] rounded-[40px] p-3 pt-11';
  return (
    <div
      role="img"
      aria-label={label}
      className={`phone relative flex shrink-0 flex-col overflow-hidden bg-background text-foreground shadow-float ${dims} ${className}`}
      {...rest}
    >
      <span
        aria-hidden
        className={`absolute left-1/2 -translate-x-1/2 rounded-full bg-default ${size === 'sm' ? 'top-2.5 h-5 w-16' : 'top-3 h-6 w-20'}`}
      />
      {children}
    </div>
  );
}
