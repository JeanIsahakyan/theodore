import {
  Bell,
  CodeMerge,
  Comment,
  Fingerprint,
  Keyboard,
  ListUl,
  LogoGithub,
  Persons,
  Shield,
  Star,
  TriangleExclamation,
} from '@gravity-ui/icons';
import { usePageData } from '../app/data';
import { Link } from '../app/router';
import {
  ButtonLink,
  Container,
  Fact,
  Feature,
  Section,
  TextLink,
} from '../components/ui';
import { CLOUD_LICENSE, DOC, GITHUB, LICENSE, WEB_APP } from '../content/links';
import { HeroDemo } from '../demo/HeroDemo';
import { PhoneMock } from '../mocks/PhoneMock';
import { ReviewMock } from '../mocks/ReviewMock';
import { SpacesMock } from '../mocks/SpacesMock';

function Hero() {
  const { release } = usePageData();
  return (
    <div>
      <Container className="pb-14 pt-14 md:pt-20 lg:pb-20">
        <div className="grid grid-cols-1 items-center gap-12 lg:grid-cols-12 lg:gap-10">
          <div className="lg:col-span-5">
            <h1 className="text-[2.5rem] font-semibold leading-[1.02] tracking-[-0.025em] text-balance sm:text-[3.4rem] lg:text-[3.6rem] xl:text-[4rem]">
              Your coding agents keep working after you leave the desk.
            </h1>
            <p className="mt-6 max-w-[48ch] text-[18px] leading-relaxed text-ink-2 md:text-[19px]">
              Theodore runs Claude Code, Codex and Gemini CLI on your computer,
              each change in its own space. When an agent needs you, your phone
              buzzes. Answer, and it carries on. Then review the result by
              meaning and open the pull request from the same window.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <ButtonLink href="/download" tone="primary" size="lg">
                Download
              </ButtonLink>
              <ButtonLink href={WEB_APP} tone="ghost" size="lg">
                Open the web app
              </ButtonLink>
            </div>
            <p className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-[14px] text-ink-2">
              {release && (
                <Link
                  href={`/releases#v${release.version}`}
                  className="press rounded text-foreground underline decoration-foreground/30 underline-offset-[3px] hover:decoration-foreground"
                >
                  v{release.version} · What's new
                </Link>
              )}
              <span>macOS and Linux. Free and open source.</span>
            </p>
          </div>
          <div className="min-w-0 lg:col-span-7">
            <HeroDemo />
          </div>
        </div>
      </Container>
      <TrustStrip />
    </div>
  );
}

function TrustStrip() {
  const { stars } = usePageData();
  return (
    <div className="border-y border-separator bg-surface-secondary">
      <Container className="flex flex-wrap items-center gap-x-8 gap-y-2 py-4 text-[14px] text-ink-2">
        <span>
          Works with{' '}
          <span className="font-medium text-foreground">Claude Code</span> ·{' '}
          <span className="font-medium text-foreground">Codex</span> ·{' '}
          <span className="font-medium text-foreground">Gemini CLI</span>
        </span>
        <span>Uses the subscriptions you already have</span>
        <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1">
          <Link
            href={GITHUB}
            className="press inline-flex items-center gap-1.5 rounded text-foreground hover:text-accent"
          >
            <LogoGithub className="size-3.5" aria-hidden />
            Open source
            {stars != null && (
              <span className="inline-flex items-center gap-1 tabular-nums">
                <Star className="size-3" aria-hidden />
                {stars.toLocaleString('en-US')}
              </span>
            )}
          </Link>
          <span>
            · apps{' '}
            <Link
              href={LICENSE}
              className="press rounded underline decoration-foreground/30 underline-offset-[3px] hover:text-foreground"
            >
              MIT
            </Link>
            , cloud{' '}
            <Link
              href={CLOUD_LICENSE}
              className="press rounded underline decoration-foreground/30 underline-offset-[3px] hover:text-foreground"
            >
              FSL
            </Link>
          </span>
        </span>
      </Container>
    </div>
  );
}

function Spaces() {
  return (
    <Feature
      id="spaces"
      eyebrow="Spaces"
      title="One change, one space. As many as you like, at once."
      mock={<SpacesMock />}
      wide
      points={[
        {
          title: 'Your checkout stays untouched',
          text: 'A space is a fresh worktree on its own branch. Start three and let them run while you read the first.',
        },
        {
          title: 'Sub-spaces in parallel',
          text: 'An agent can split the work, wait for its sub-spaces and merge them back. The sidebar shows the tree.',
        },
        {
          title: 'Rewind, then ship as a PR',
          text: 'Every turn is a checkpoint. Open PR squashes the turns into one commit by you; later turns push to it.',
        },
      ]}
    >
      Say what you want. The agent writes the change in its own copy of the
      repository while you watch the live diff and keep talking. Claude Code,
      Codex or Gemini CLI, the model and the mode, picked per space.
    </Feature>
  );
}

function Review() {
  return (
    <Feature
      id="review"
      eyebrow="Review"
      title="Read a pull request as the steps it takes, not the files it touches."
      mock={<ReviewMock />}
      flip
      points={[
        {
          title: 'Grouped, with a why',
          text: 'Titled groups in reading order, each with why it is there, its risk and a checklist. Read state survives a push.',
        },
        {
          title: 'Findings stay in the app',
          text: 'Review skills run on the agent you pick. You turn the findings you agree with into one review, or into tasks.',
        },
        {
          title: 'Merge with the facts',
          text: 'Conflicts computed locally against the base, checks followed as they finish. Merge, enqueue or auto-merge from the header.',
        },
      ]}
    >
      A diff in file order hides the story: the model, the API that uses it and
      its tests sit far apart. Theodore has your agent regroup the diff by
      meaning and keeps track of what you've read.
    </Feature>
  );
}

function YourPhone() {
  return (
    <Feature
      id="phone"
      eyebrow="Your phone"
      title="Your phone is the remote. Your computers do the work."
      mock={<PhoneMock />}
      points={[
        {
          title: 'Notifications that act',
          text: 'A question arrives as a push with its options as buttons. One tap answers it. A finished space tells you so.',
        },
        {
          title: 'Start, follow, steer',
          text: 'Start a space on any of your computers, send a photo of the whiteboard, approve a plan, archive what is done.',
        },
        {
          title: 'Your devices decide, the cloud relays',
          text: 'Every device has its own key and every message is signed. A computer runs only what a device you trust asked for.',
        },
      ]}
    >
      Theodore Code for iPhone, Android and the web follows the spaces on your
      computers. The Theodore cloud only relays between your devices.
    </Feature>
  );
}

function More() {
  return (
    <Section
      id="more"
      tone="tinted"
      title="And the rest of the window."
      intro="Everything between the first message and the merge, in one place."
    >
      <div className="mt-12 grid grid-cols-1 gap-x-12 gap-y-8 md:grid-cols-2">
        <Fact icon={<Comment />} title="Agents in the loop">
          Ask about any line, group or the whole PR. Run review skills for bugs,
          security and tests. A finding becomes a comment, a task or a fix.
        </Fact>
        <Fact icon={<ListUl />} title="One inbox">
          Review requests, assignments and mentions, with snooze until a push or
          until the checks go green.
        </Fact>
        <Fact icon={<CodeMerge />} title="After a push, only what changed">
          Revisions keep their place. The interdiff flags only new or changed
          hunks, with a view of what changed since you last looked.
        </Fact>
        <Fact icon={<Keyboard />} title="Keyboard-first, local-first">
          ⌘K finds every action and PR. State lives on your disk; writes queue
          and go out when you're back online.
        </Fact>
        <Fact icon={<Bell />} title="Code intelligence">
          ⌘-click an identifier for its definitions and references across the
          worktree. Agents get the same symbol tools instead of grep.
        </Fact>
        <Fact icon={<Persons />} title="GitHub, GitLab, Bitbucket">
          GitHub is the most complete. GitLab and Bitbucket Cloud are real,
          narrower adapters behind Labs.
        </Fact>
        <Fact icon={<Fingerprint />} title="Spaces across your computers">
          Start a space on your Linux box from your Mac. An agent can hand part
          of the work to another machine and wait for it.
        </Fact>
        <Fact icon={<Shield />} title="Claude via cloud">
          Add Theodore as an MCP server in Claude Code or claude.ai. Every edit
          or command waits for your Allow unless you turn on auto mode for a
          while.
        </Fact>
      </div>
    </Section>
  );
}

function Open() {
  return (
    <Section
      id="open-source"
      eyebrow="Open source"
      title="Built around the agents you already pay for."
    >
      <div className="mt-10 grid grid-cols-1 gap-8 sm:grid-cols-3">
        <Fact title="Your agents, your machine">
          Claude Code, Codex and Gemini CLI run on your computer, signed in to
          your own accounts. Theodore has no review server.
        </Fact>
        <Fact title="MIT, and FSL for the cloud">
          The desktop and phone apps are MIT; the cloud is source-available
          under FSL and turns Apache 2.0 after two years.
        </Fact>
        <Fact title="Honest about data">
          Diagnostics are off until you say yes, and redacted before they leave.
          The <TextLink href="/privacy">privacy policy</TextLink> says what the
          cloud sees.
        </Fact>
      </div>
      <div className="mt-10 flex flex-wrap gap-3">
        <ButtonLink
          href={GITHUB}
          tone="secondary"
          icon={<LogoGithub className="size-4" />}
        >
          View on GitHub
        </ButtonLink>
        <ButtonLink href={DOC('plan.md')} tone="ghost">
          Read the design
        </ButtonLink>
        <ButtonLink href={LICENSE} tone="ghost">
          License
        </ButtonLink>
      </div>
    </Section>
  );
}

function Cta() {
  return (
    <section
      id="start"
      aria-labelledby="start-h"
      className="border-t border-separator bg-surface-secondary py-20 md:py-28"
    >
      <Container>
        <h2
          id="start-h"
          className="max-w-3xl text-[2rem] font-semibold leading-[1.1] tracking-[-0.02em] text-balance md:text-5xl"
        >
          Start a space, then go for a walk.
        </h2>
        <div className="mt-8 flex flex-wrap gap-3">
          <ButtonLink href="/download" tone="primary" size="lg">
            Download Theodore
          </ButtonLink>
          <ButtonLink href={WEB_APP} tone="ghost" size="lg">
            Open the web app
          </ButtonLink>
        </div>
        <p className="mt-5 flex max-w-[60ch] items-start gap-2 text-[15px] text-ink-2">
          <TriangleExclamation className="mt-0.5 size-4 shrink-0 text-warning" />
          You need git and at least one agent CLI installed and signed in:
          claude, codex or gemini.
        </p>
      </Container>
    </section>
  );
}

export function Home() {
  return (
    <>
      <Hero />
      <Spaces />
      <Review />
      <YourPhone />
      <More />
      <Open />
      <Cta />
    </>
  );
}
