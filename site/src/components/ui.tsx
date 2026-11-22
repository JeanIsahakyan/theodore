/**
 * The site's small building blocks, in the desktop's tones: link buttons
 * shaped like HeroUI's, a section with its heading, a page container.
 */
import type { ReactNode } from 'react';
import { Link } from '../app/router';

export function Container({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`mx-auto w-full max-w-6xl px-5 sm:px-8 ${className}`}>
      {children}
    </div>
  );
}

export type ButtonTone = 'primary' | 'secondary' | 'ghost';

const TONES: Record<ButtonTone, string> = {
  primary:
    'bg-accent text-accent-foreground hover:bg-accent-hover shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]',
  secondary: 'bg-default text-foreground hover:bg-default-hover',
  ghost:
    'border border-separator text-foreground hover:bg-default/60 bg-transparent',
};

/** A link that looks like the app's buttons (`Btn` in ui/src/ui/bits.tsx). */
export function ButtonLink({
  href,
  tone = 'secondary',
  size = 'md',
  icon,
  children,
  className = '',
}: {
  href: string;
  tone?: ButtonTone;
  size?: 'sm' | 'md' | 'lg';
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const h =
    size === 'lg'
      ? 'h-12 px-5 text-base'
      : size === 'sm'
        ? 'h-8 px-3 text-sm'
        : 'h-10 px-4 text-sm';
  return (
    <Link
      href={href}
      className={`inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-xl font-medium transition-colors ${h} ${TONES[tone]} ${className}`}
    >
      {icon}
      {children}
    </Link>
  );
}

export function Section({
  id,
  eyebrow,
  title,
  intro,
  children,
  className = '',
}: {
  id: string;
  eyebrow?: string;
  title: ReactNode;
  intro?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-h`}
      className={`scroll-mt-20 border-t border-separator py-20 md:py-28 ${className}`}
    >
      <Container>
        <div className="max-w-3xl">
          {eyebrow && (
            <p className="mb-3 text-sm font-medium text-accent">{eyebrow}</p>
          )}
          <h2
            id={`${id}-h`}
            className="text-3xl font-semibold tracking-tight text-balance md:text-5xl"
          >
            {title}
          </h2>
          {intro && (
            <p className="mt-5 text-lg leading-relaxed text-muted">{intro}</p>
          )}
        </div>
        {children}
      </Container>
    </section>
  );
}

/** A short fact: a title and a line or two. */
export function Fact({
  icon,
  title,
  children,
}: {
  icon?: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      {icon && (
        <span className="grid size-9 place-items-center rounded-xl bg-default text-foreground [&>svg]:size-4">
          {icon}
        </span>
      )}
      <h3 className="text-base font-semibold">{title}</h3>
      <p className="text-[15px] leading-relaxed text-muted">{children}</p>
    </div>
  );
}

/** Prose pages (privacy, terms): the desktop's markdown rhythm. */
export function Prose({ children }: { children: ReactNode }) {
  return (
    <div className="prose-wrap max-w-3xl text-[15px] leading-relaxed [&_a]:underline [&_a]:underline-offset-2 [&_h2]:mt-10 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:tracking-tight [&_h3]:mt-6 [&_h3]:font-semibold [&_li]:my-1 [&_p]:my-3 [&_table]:my-4 [&_table]:w-full [&_table]:border-collapse [&_table]:text-sm [&_td]:border-t [&_td]:border-separator [&_td]:px-2 [&_td]:py-2 [&_td]:align-top [&_th]:px-2 [&_th]:py-2 [&_th]:text-start [&_th]:font-semibold [&_ul]:list-disc [&_ul]:ps-6">
      {children}
    </div>
  );
}
