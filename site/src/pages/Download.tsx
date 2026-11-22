import { useEffect, useState, type ReactNode } from 'react';
import {
  ArrowDownToLine,
  Globe,
  LogoAndroid,
  LogoApple,
  LogoLinux,
  LogoWindows,
} from '@gravity-ui/icons';
import { usePageData } from '../app/data';
import { Link } from '../app/router';
import { ButtonLink, Container } from '../components/ui';
import { DOC, RELEASES, RELEASES_LATEST, WEB_APP } from '../content/links';
import { detectInBrowser, type Platform } from '../download/platform';
import {
  assetUrl,
  fetchRelease,
  formatDate,
  formatSize,
  type AssetKey,
  type Release,
} from '../download/release';

interface Option {
  id: string;
  /** The platforms this option is first for. */
  forPlatforms: Platform[];
  icon: ReactNode;
  title: string;
  subtitle: string;
  downloads: { label: string; key: AssetKey }[];
  /** For a platform without a build. */
  soon?: { title: string; text: string; cta?: { href: string; label: string } };
  notes: ReactNode;
}

const OPTIONS: Option[] = [
  {
    id: 'mac',
    forPlatforms: ['mac-arm64', 'mac'],
    icon: <LogoApple />,
    title: 'macOS',
    subtitle: 'Apple Silicon · macOS 13 or later',
    downloads: [{ label: 'Download .dmg', key: 'mac-arm64-dmg' }],
    notes: (
      <>
        Open the disk image and drag Theodore to Applications. Releases are
        signed with a Developer ID and notarized by Apple, so macOS opens them
        without a warning. From then on it updates itself.
      </>
    ),
  },
  {
    id: 'mac-intel',
    forPlatforms: ['mac-x64'],
    icon: <LogoApple />,
    title: 'macOS on Intel',
    subtitle: 'Not available yet',
    downloads: [],
    soon: {
      title: 'Apple Silicon only, for now',
      text: 'Theodore is built for Apple Silicon Macs. On an Intel Mac, follow your spaces in the web app.',
      cta: { href: WEB_APP, label: 'Use the web app' },
    },
    notes: null,
  },
  {
    id: 'linux-x64',
    forPlatforms: ['linux-x64', 'linux'],
    icon: <LogoLinux />,
    title: 'Linux x86_64',
    subtitle: 'glibc 2.35+ · Ubuntu 22.04+, Debian 12+',
    downloads: [
      { label: 'AppImage', key: 'linux-x64-appimage' },
      { label: '.deb', key: 'linux-x64-deb' },
    ],
    notes: <LinuxNotes arch="amd64" />,
  },
  {
    id: 'linux-arm64',
    forPlatforms: ['linux-arm64'],
    icon: <LogoLinux />,
    title: 'Linux arm64',
    subtitle: 'glibc 2.35+ · Ubuntu 22.04+, Debian 12+',
    downloads: [
      { label: 'AppImage', key: 'linux-arm64-appimage' },
      { label: '.deb', key: 'linux-arm64-deb' },
    ],
    notes: <LinuxNotes arch="arm64" />,
  },
  {
    id: 'ios',
    forPlatforms: ['ios'],
    icon: <LogoApple />,
    title: 'iPhone',
    subtitle: 'Theodore Code',
    downloads: [],
    soon: {
      title: 'Coming soon to the App Store',
      text: 'Theodore Code for iPhone has been submitted to the App Store and is in review. Until it is out, the web app does the same job in Safari.',
      cta: { href: WEB_APP, label: 'Use the web app' },
    },
    notes: null,
  },
  {
    id: 'android',
    forPlatforms: ['android'],
    icon: <LogoAndroid />,
    title: 'Android',
    subtitle: 'Theodore Code',
    downloads: [],
    soon: {
      title: 'Coming soon',
      text: 'The Android app is built and not yet on Google Play. Until then, the web app works in Chrome.',
      cta: { href: WEB_APP, label: 'Use the web app' },
    },
    notes: null,
  },
  {
    id: 'web',
    forPlatforms: [],
    icon: <Globe />,
    title: 'Web app',
    subtitle: 'app.theodore.cloud',
    downloads: [],
    soon: {
      title: 'Follow and steer from any browser',
      text: 'Sign in with your Theodore account, trust the browser from one of your computers, and start, follow and answer spaces. No install.',
      cta: { href: WEB_APP, label: 'Open the web app' },
    },
    notes: null,
  },
  {
    id: 'windows',
    forPlatforms: ['windows'],
    icon: <LogoWindows />,
    title: 'Windows',
    subtitle: 'Not yet',
    downloads: [],
    soon: {
      title: 'No Windows build yet',
      text: 'Theodore runs on macOS and Linux. On Windows, use the web app to follow the spaces running on your other computers.',
      cta: { href: WEB_APP, label: 'Use the web app' },
    },
    notes: null,
  },
];

function LinuxNotes({ arch }: { arch: 'amd64' | 'arm64' }) {
  return (
    <>
      <strong className="font-medium text-foreground">AppImage</strong>: put it
      somewhere you can write, such as ~/Applications, then make it executable
      and run it. It updates itself in place. If it won't start, install FUSE 2
      (libfuse2, or libfuse2t64 on Ubuntu 24.04).{' '}
      <strong className="font-medium text-foreground">.deb</strong>:{' '}
      <code className="rounded bg-default px-1 py-0.5 font-mono text-[12px]">
        sudo apt install ./Theodore_&lt;version&gt;_{arch}.deb
      </code>
      ; it pulls in WebKitGTK 4.1 and git, and updates through dpkg with a
      password prompt. Theodore also needs a login shell whose PATH finds
      claude, codex, gemini and gh, and a Secret Service provider (GNOME Keyring
      or KWallet) for stored tokens.
    </>
  );
}

function useRelease(): Release | null {
  const baked = usePageData().release;
  const [release, setRelease] = useState(baked);
  useEffect(() => {
    let live = true;
    void fetchRelease().then((r) => {
      if (live && r) setRelease(r);
    });
    return () => {
      live = false;
    };
  }, []);
  return release;
}

function usePlatform(): Platform | null {
  const [p, setP] = useState<Platform | null>(null);
  useEffect(() => {
    let live = true;
    void detectInBrowser().then((d) => {
      if (live) setP(d);
    });
    return () => {
      live = false;
    };
  }, []);
  return p;
}

function OptionCard({
  o,
  release,
  highlighted,
}: {
  o: Option;
  release: Release | null;
  highlighted: boolean;
}) {
  return (
    <li
      id={o.id}
      className={`flex flex-col gap-3 rounded-2xl border bg-surface p-5 ${
        highlighted ? 'border-accent ring-2 ring-accent/30' : 'border-separator'
      }`}
    >
      <div className="flex items-center gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-default [&>svg]:size-5">
          {o.icon}
        </span>
        <div className="min-w-0">
          <h2 className="text-base font-semibold">{o.title}</h2>
          <p className="text-sm text-muted">{o.subtitle}</p>
        </div>
        {highlighted && (
          <span className="ms-auto shrink-0 rounded-full bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent">
            Your device
          </span>
        )}
      </div>
      {o.downloads.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {o.downloads.map((d, i) => {
            const a = release?.assets[d.key];
            return (
              <ButtonLink
                key={d.key}
                href={assetUrl(release, d.key)}
                tone={i === 0 && highlighted ? 'primary' : 'secondary'}
                icon={<ArrowDownToLine className="size-4" />}
              >
                {d.label}
                {a && (
                  <span className="text-xs opacity-70">
                    {formatSize(a.size)}
                  </span>
                )}
              </ButtonLink>
            );
          })}
        </div>
      )}
      {o.soon && (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">{o.soon.title}</p>
          <p className="text-sm text-muted">{o.soon.text}</p>
          {o.soon.cta && (
            <div>
              <ButtonLink
                href={o.soon.cta.href}
                tone={highlighted ? 'primary' : 'secondary'}
                icon={<Globe className="size-4" />}
              >
                {o.soon.cta.label}
              </ButtonLink>
            </div>
          )}
        </div>
      )}
      {o.notes && (
        <p className="text-sm leading-relaxed text-muted">{o.notes}</p>
      )}
    </li>
  );
}

export function Download() {
  const release = useRelease();
  const platform = usePlatform();
  const first = OPTIONS.find(
    (o) => platform && o.forPlatforms.includes(platform),
  );
  const ordered = first
    ? [first, ...OPTIONS.filter((o) => o !== first)]
    : OPTIONS;
  return (
    <div className="py-14 md:py-20">
      <Container>
        <div className="max-w-3xl">
          <h1 className="text-4xl font-semibold tracking-tight md:text-6xl">
            Download Theodore
          </h1>
          <p className="mt-4 text-lg text-muted">
            {release ? (
              <>
                Version{' '}
                <span className="font-medium text-foreground">
                  {release.version}
                </span>
                {release.publishedAt && (
                  <>, released {formatDate(release.publishedAt)}</>
                )}
                . Free, open source, updates itself.
              </>
            ) : (
              <>
                The latest release is on{' '}
                <Link
                  href={RELEASES_LATEST}
                  className="underline underline-offset-2"
                >
                  GitHub
                </Link>
                . Free, open source, updates itself.
              </>
            )}
          </p>
          <p className="mt-2 text-sm text-muted">
            You need git and at least one agent CLI installed and signed in
            (claude, codex or gemini), and a GitHub account for your pull
            requests.
          </p>
        </div>
        <ul className="mt-10 grid grid-cols-1 gap-4 md:grid-cols-2">
          {ordered.map((o) => (
            <OptionCard
              key={o.id}
              o={o}
              release={release}
              highlighted={o === first}
            />
          ))}
        </ul>
        <div className="mt-10 max-w-3xl text-sm leading-relaxed text-muted">
          <p>
            Every release on{' '}
            <Link href={RELEASES} className="underline underline-offset-2">
              GitHub Releases
            </Link>
            , with notes. A staging channel exists for pre-release builds; how
            builds are made and signed is in{' '}
            <Link
              href={DOC('releasing.md')}
              className="underline underline-offset-2"
            >
              docs/releasing.md
            </Link>
            . Building from source is for developing Theodore: a local build has
            no account sign-in and no diagnostics.
          </p>
        </div>
      </Container>
    </div>
  );
}
