/**
 * The changelog: every app release, newest first, with its notes. Baked in
 * at build time; in the browser the latest release is checked again, so a
 * release that came out since the build still shows. The newest ten are
 * open; older ones sit in a <details>, which works without JavaScript and
 * opens itself when the address names one of them.
 */
import { useEffect, useState } from 'react';
import { ArrowDownToLine, LogoGithub } from '@gravity-ui/icons';
import { usePageData } from '../app/data';
import { useRouter } from '../app/router';
import { ButtonLink, Container, TextLink } from '../components/ui';
import { RELEASES } from '../content/links';
import { fetchRelease, formatDate } from '../download/release';
import { ownNotes, sortReleases, type ReleaseNote } from '../releases/notes';
import { renderMarkdown } from '../releases/markdown';

const OPEN = 10;

function useReleases(): ReleaseNote[] | null {
  const baked = usePageData().releases;
  const [list, setList] = useState<ReleaseNote[] | null>(baked ?? null);
  useEffect(() => {
    let live = true;
    const merge = (fresh: ReleaseNote[]) =>
      setList((cur) => {
        const seen = new Set((cur ?? []).map((r) => r.version));
        const add = fresh.filter((r) => !seen.has(r.version));
        return sortReleases([...(cur ?? []), ...add]);
      });
    const work = async () => {
      // A visit that navigated here from another page has nothing baked.
      if (!baked) {
        try {
          const res = await fetch('/releases.json');
          if (res.ok && live) merge((await res.json()) as ReleaseNote[]);
        } catch {
          // offline: the latest below may still answer
        }
      }
      const latest = await fetchRelease();
      if (!live || !latest) return;
      const notes = ownNotes(latest.body);
      merge([
        {
          version: latest.version,
          publishedAt: latest.publishedAt,
          url: latest.url,
          html: notes ? renderMarkdown(notes) : null,
        },
      ]);
    };
    void work();
    return () => {
      live = false;
    };
  }, [baked]);
  return list;
}

function Entry({ r, latest }: { r: ReleaseNote; latest: boolean }) {
  return (
    <article
      id={`v${r.version}`}
      className="scroll-mt-24 border-t border-separator py-10 md:grid md:grid-cols-[180px_minmax(0,1fr)] md:gap-10"
    >
      <header className="mb-4 md:mb-0">
        <h2 className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[22px] font-semibold tracking-[-0.01em]">
          <a
            href={`#v${r.version}`}
            className="press rounded tabular-nums [overflow-wrap:anywhere]"
          >
            v{r.version}
          </a>
          {latest && (
            <span className="rounded-full bg-signal px-2 py-0.5 text-[11px] font-medium text-signal-ink">
              Latest
            </span>
          )}
        </h2>
        {r.publishedAt && (
          <time
            dateTime={r.publishedAt}
            className="mt-1 block text-[15px] text-ink-2"
          >
            {formatDate(r.publishedAt)}
          </time>
        )}
        {r.url && (
          <TextLink
            href={r.url}
            className="mt-1 inline-flex items-center gap-1 text-[14px] text-ink-2"
          >
            <LogoGithub className="size-3.5" aria-hidden />
            On GitHub
          </TextLink>
        )}
      </header>
      {r.html ? (
        <div
          className="notes max-w-[72ch]"
          // Rendered by src/releases/markdown.ts: every string is escaped
          // and only its own tags are emitted.
          dangerouslySetInnerHTML={{ __html: r.html }}
        />
      ) : (
        <p className="text-[17px] text-ink-2">Maintenance release.</p>
      )}
    </article>
  );
}

export function Releases() {
  const list = useReleases();
  const { release } = usePageData();
  const { path } = useRouter();
  // A link to an older release opens the folded part.
  useEffect(() => {
    const hash = window.location.hash;
    if (!hash) return;
    const target = document.getElementById(hash.slice(1));
    const details = target?.closest('details');
    if (details && !details.open) {
      details.open = true;
      target?.scrollIntoView();
    }
  }, [list, path]);

  const open = list?.slice(0, OPEN) ?? [];
  const older = list?.slice(OPEN) ?? [];
  const latestVersion = list?.[0]?.version;
  const dmg = release?.assets['mac-arm64-dmg'];

  return (
    <div className="py-14 md:py-20">
      <Container>
        <div className="max-w-3xl">
          <h1 className="text-[2.5rem] font-semibold leading-[1.05] tracking-[-0.025em] md:text-6xl">
            Changelog
          </h1>
          <p className="mt-4 max-w-[60ch] text-[18px] leading-relaxed text-ink-2 md:text-xl">
            Every release of Theodore, newest first. The desktop app updates
            itself; the notes say what got faster, what got fixed and what to
            know.
          </p>
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <ButtonLink
              href={dmg?.url ?? '/download'}
              tone="primary"
              icon={<ArrowDownToLine className="size-4" />}
            >
              {latestVersion
                ? `Download v${latestVersion}`
                : 'Download the latest'}
            </ButtonLink>
            <ButtonLink href="/download" tone="ghost">
              All platforms
            </ButtonLink>
          </div>
        </div>
        <div className="mt-12">
          {list == null && (
            <p className="border-t border-separator py-10 text-[17px] text-ink-2">
              The release notes couldn't be loaded. They are on{' '}
              <TextLink href={RELEASES}>GitHub Releases</TextLink>.
            </p>
          )}
          {list?.length === 0 && (
            <p className="border-t border-separator py-10 text-[17px] text-ink-2">
              No releases yet.
            </p>
          )}
          {open.map((r, i) => (
            <Entry key={r.version} r={r} latest={i === 0} />
          ))}
          {older.length > 0 && (
            <details className="group border-t border-separator">
              <summary className="press flex cursor-pointer list-none items-center gap-2 py-6 text-[17px] font-medium marker:hidden [&::-webkit-details-marker]:hidden">
                <span className="grid size-6 place-items-center rounded-full bg-default text-[13px] transition-transform group-open:rotate-90">
                  ›
                </span>
                <span className="group-open:hidden">
                  Show {older.length} older{' '}
                  {older.length === 1 ? 'release' : 'releases'}
                </span>
                <span className="hidden group-open:inline">Older releases</span>
              </summary>
              {older.map((r) => (
                <Entry key={r.version} r={r} latest={false} />
              ))}
            </details>
          )}
        </div>
      </Container>
    </div>
  );
}
