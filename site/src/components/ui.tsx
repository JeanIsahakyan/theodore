/**
 * The site's small building blocks: link buttons that give on press, a
 * section with its heading, a feature row with its mock, a page container,
 * prose.
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

/** The app's `Btn` tones (ui/src/ui/bits.tsx): primary is the accent. */
const TONES: Record<ButtonTone, string> = {
  primary:
    'bg-accent text-accent-foreground hover:bg-accent-hover shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]',
  secondary: 'bg-default text-foreground hover:bg-default-hover',
  ghost:
    'text-foreground bg-transparent shadow-[inset_0_0_0_1px_var(--separator)] hover:bg-default/60',
};

/** A link that looks like the app's buttons (`Btn` in ui/src/ui/bits.tsx)
 *  and gives under the finger. */
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
      ? 'h-12 px-6 text-[17px]'
      : size === 'sm'
        ? 'h-8 px-3 text-sm'
        : 'h-10 px-4 text-[15px]';
  return (
    <Link
      href={href}
      className={`press inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-xl font-medium ${h} ${TONES[tone]} ${className}`}
    >
      {icon}
      {children}
    </Link>
  );
}

/** A text link with an underline that darkens on hover. */
export function TextLink({
  href,
  children,
  className = '',
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={`rounded underline decoration-foreground/30 underline-offset-[3px] hover:decoration-foreground ${className}`}
    >
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
  tone = 'light',
}: {
  id: string;
  eyebrow?: string;
  title: ReactNode;
  intro?: ReactNode;
  children?: ReactNode;
  className?: string;
  tone?: 'light' | 'tinted';
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-h`}
      className={`scroll-mt-20 py-20 md:py-28 ${tone === 'tinted' ? 'bg-surface-secondary' : ''} ${className}`}
    >
      <Container>
        <div className="max-w-3xl">
          {eyebrow && (
            <p className="mb-3 text-[15px] font-medium text-ink-2">{eyebrow}</p>
          )}
          <h2
            id={`${id}-h`}
            className="text-[2rem] font-semibold leading-[1.1] tracking-[-0.02em] text-balance md:text-5xl"
          >
            {title}
          </h2>
          {intro && (
            <p className="mt-5 max-w-[62ch] text-[18px] leading-relaxed text-ink-2 md:text-xl">
              {intro}
            </p>
          )}
        </div>
        {children}
      </Container>
    </section>
  );
}

/** A large feature: copy on one side, a live mock on the other. `flip` puts
 *  the mock first on wide screens, so consecutive features alternate. */
export function Feature({
  id,
  eyebrow,
  title,
  children,
  mock,
  flip = false,
  points,
  wide = false,
}: {
  id: string;
  eyebrow: string;
  title: ReactNode;
  children: ReactNode;
  mock: ReactNode;
  flip?: boolean;
  /** Three short facts under the copy. */
  points?: { title: string; text: ReactNode }[];
  /** A wider mock (a window with a sidebar and a pane): 8 columns of 12. */
  wide?: boolean;
}) {
  const text = wide ? 'lg:col-span-4' : 'lg:col-span-5';
  const art = wide ? 'lg:col-span-8' : 'lg:col-span-7';
  return (
    <section
      id={id}
      aria-labelledby={`${id}-h`}
      className="scroll-mt-20 py-16 md:py-24"
    >
      <Container>
        <div className="grid grid-cols-1 items-center gap-10 lg:grid-cols-12 lg:gap-14">
          <div className={`${text} ${flip ? 'lg:order-2' : ''}`}>
            <p className="mb-3 text-[15px] font-medium text-ink-2">{eyebrow}</p>
            <h2
              id={`${id}-h`}
              className="text-[1.9rem] font-semibold leading-[1.1] tracking-[-0.02em] text-balance md:text-[2.6rem]"
            >
              {title}
            </h2>
            <div className="mt-5 max-w-[56ch] text-[17px] leading-relaxed text-ink-2 md:text-[18px]">
              {children}
            </div>
            {points && (
              <dl className="mt-8 flex flex-col gap-4">
                {points.map((p) => (
                  <div key={p.title} className="flex flex-col gap-0.5">
                    <dt className="text-[16px] font-semibold">{p.title}</dt>
                    <dd className="max-w-[56ch] text-[15.5px] leading-relaxed text-ink-2">
                      {p.text}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
          <div className={`min-w-0 ${art} ${flip ? 'lg:order-1' : ''}`}>
            {mock}
          </div>
        </div>
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
    <div className="flex gap-4">
      {icon && (
        <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-xl bg-default text-foreground [&>svg]:size-4">
          {icon}
        </span>
      )}
      <div className="flex min-w-0 flex-col gap-1">
        <h3 className="text-[16px] font-semibold">{title}</h3>
        <p className="max-w-[52ch] text-[15.5px] leading-relaxed text-ink-2">
          {children}
        </p>
      </div>
    </div>
  );
}

/** Prose pages (privacy, terms): the desktop's markdown rhythm. */
export function Prose({ children }: { children: ReactNode }) {
  return (
    <div className="prose-wrap max-w-[70ch] text-[17px] leading-relaxed text-ink-2 [&_a]:text-foreground [&_a]:underline [&_a]:decoration-foreground/30 [&_a]:underline-offset-[3px] [&_h2]:mt-10 [&_h2]:text-[22px] [&_h2]:font-semibold [&_h2]:tracking-[-0.01em] [&_h2]:text-foreground [&_h3]:mt-6 [&_h3]:font-semibold [&_h3]:text-foreground [&_li]:my-1.5 [&_p]:my-3 [&_strong]:font-semibold [&_strong]:text-foreground [&_table]:my-4 [&_table]:w-full [&_table]:border-collapse [&_table]:text-[15px] [&_td]:border-t [&_td]:border-separator [&_td]:px-2 [&_td]:py-2 [&_td]:align-top [&_th]:px-2 [&_th]:py-2 [&_th]:text-start [&_th]:font-semibold [&_th]:text-foreground [&_ul]:list-disc [&_ul]:ps-6">
      {children}
    </div>
  );
}
