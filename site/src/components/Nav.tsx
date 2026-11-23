import { LogoGithub, Moon, Sun } from '@gravity-ui/icons';
import { Link } from '../app/router';
import { toggleTheme } from '../app/theme';
import { DOCS, GITHUB } from '../content/links';
import { LogoArt } from '../shared/LogoArt';
import { ButtonLink, Container } from './ui';

const ICON_BTN =
  'press grid size-9 shrink-0 place-items-center rounded-xl text-ink-2 transition-colors hover:bg-default hover:text-foreground';
const TEXT_BTN =
  'press h-9 items-center rounded-xl px-3 text-[15px] text-ink-2 transition-colors hover:bg-default hover:text-foreground';

/** Light or dark. Both icons are in the markup and CSS shows one, so the
 *  server-rendered page needs no script to be right. */
function ThemeToggle() {
  return (
    <button
      type="button"
      aria-label="Switch between light and dark theme"
      onClick={toggleTheme}
      className={ICON_BTN}
    >
      <Sun className="only-dark size-4" aria-hidden />
      <Moon className="only-light size-4" aria-hidden />
    </button>
  );
}

export function Nav() {
  return (
    <header className="sticky top-0 z-40 border-b border-separator/70 bg-background/80 backdrop-blur-md [padding-top:env(safe-area-inset-top)]">
      <Container className="flex h-14 items-center gap-2">
        <Link
          href="/"
          className="press flex items-center gap-2 rounded-xl text-[17px] font-semibold tracking-tight"
          aria-label="Theodore home"
        >
          <LogoArt size={24} />
          Theodore
        </Link>
        <nav aria-label="Main" className="ms-auto flex items-center gap-0.5">
          <Link
            href="/releases"
            className={`${TEXT_BTN} hidden sm:inline-flex`}
          >
            Changelog
          </Link>
          <Link href={DOCS} className={`${TEXT_BTN} hidden sm:inline-flex`}>
            Docs
          </Link>
          <Link
            href={GITHUB}
            aria-label="Theodore on GitHub"
            className={ICON_BTN}
          >
            <LogoGithub className="size-4" aria-hidden />
          </Link>
          <ThemeToggle />
          <ButtonLink
            href="/download"
            tone="primary"
            size="sm"
            className="ms-1.5"
          >
            Download
          </ButtonLink>
        </nav>
      </Container>
    </header>
  );
}
