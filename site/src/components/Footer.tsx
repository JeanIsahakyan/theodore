import { Link } from '../app/router';
import { CLOUD_LICENSE, GITHUB, LICENSE } from '../content/links';
import { LogoArt } from '../shared/LogoArt';
import { Container } from './ui';

const LINKS = [
  { href: '/download', label: 'Download' },
  { href: '/releases', label: 'Changelog' },
  { href: GITHUB, label: 'GitHub' },
  { href: LICENSE, label: 'MIT License' },
  { href: CLOUD_LICENSE, label: 'Cloud license (FSL)' },
  { href: '/privacy', label: 'Privacy' },
  { href: '/terms', label: 'Terms' },
];

export function Footer({ year }: { year: number }) {
  return (
    <footer className="border-t border-separator py-10 text-[15px] text-ink-2 [padding-bottom:calc(2.5rem+env(safe-area-inset-bottom))]">
      <Container className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <span className="inline-flex items-center gap-2">
          <LogoArt size={18} />© {year} Theodore
        </span>
        <nav
          aria-label="Footer"
          className="flex flex-wrap gap-x-5 gap-y-2 sm:ms-auto"
        >
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="press rounded transition-colors hover:text-foreground"
            >
              {l.label}
            </Link>
          ))}
        </nav>
      </Container>
    </footer>
  );
}
