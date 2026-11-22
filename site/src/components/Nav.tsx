import { LogoGithub, Moon, Sun } from '@gravity-ui/icons';
import { Link } from '../app/router';
import { toggleTheme } from '../app/theme';
import { DOCS, GITHUB } from '../content/links';
import { LogoArt } from '../shared/LogoArt';
import { ButtonLink, Container } from './ui';

/** Light or dark. Both icons are in the markup and CSS shows one, so the
 *  server-rendered page needs no script to be right. */
function ThemeToggle() {
  return (
    <button
      type="button"
      aria-label="Switch between light and dark theme"
      onClick={toggleTheme}
      className="grid size-9 shrink-0 place-items-center rounded-xl text-muted transition-colors hover:bg-default hover:text-foreground"
    >
      <Sun className="only-dark size-4" aria-hidden />
      <Moon className="only-light size-4" aria-hidden />
    </button>
  );
}

export function Nav() {
  return (
    <header className="sticky top-0 z-40 border-b border-separator bg-background/85 backdrop-blur">
      <Container className="flex h-14 items-center gap-2">
        <Link
          href="/"
          className="flex items-center gap-2 rounded-xl text-base font-semibold tracking-tight"
          aria-label="Theodore home"
        >
          <LogoArt size={24} />
          Theodore
        </Link>
        <nav aria-label="Main" className="ms-auto flex items-center gap-1">
          <Link
            href={DOCS}
            className="hidden h-9 items-center rounded-xl px-3 text-sm text-muted transition-colors hover:bg-default hover:text-foreground sm:inline-flex"
          >
            Docs
          </Link>
          <Link
            href={GITHUB}
            aria-label="Theodore on GitHub"
            className="grid size-9 place-items-center rounded-xl text-muted transition-colors hover:bg-default hover:text-foreground"
          >
            <LogoGithub className="size-4" aria-hidden />
          </Link>
          <ThemeToggle />
          <ButtonLink
            href="/download"
            tone="primary"
            size="sm"
            className="ms-1"
          >
            Download
          </ButtonLink>
        </nav>
      </Container>
    </header>
  );
}
