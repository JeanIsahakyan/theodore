import {
  Bell,
  Cloud,
  CodeFork,
  CodeMerge,
  Comment,
  Eye,
  Fingerprint,
  Keyboard,
  ListUl,
  LogoGithub,
  Persons,
  Shield,
  Smartphone,
  TriangleExclamation,
} from '@gravity-ui/icons';
import { ButtonLink, Container, Fact, Section } from '../components/ui';
import { DOC, GITHUB, LICENSE, WEB_APP } from '../content/links';
import { HeroDemo } from '../demo/HeroDemo';
import { FleetMock } from '../mocks/FleetMock';
import { ReviewMock } from '../mocks/ReviewMock';
import { SpacesMock } from '../mocks/SpacesMock';
import { Link } from '../app/router';

function Hero() {
  return (
    <div className="pb-16 pt-14 md:pt-20">
      <Container>
        <div className="max-w-3xl">
          <h1 className="text-[2.6rem] font-semibold leading-[1.02] tracking-tight text-balance sm:text-6xl md:text-7xl">
            Your coding agents keep working after you leave the desk.
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-relaxed text-muted md:text-xl">
            Theodore runs{' '}
            <strong className="font-medium text-foreground">
              Claude Code, Codex and Gemini CLI
            </strong>{' '}
            on your computer, each change in its own space. When an agent needs
            you, your phone buzzes. Answer, and it carries on. Then review the
            result by meaning and open the pull request from the same window.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <ButtonLink href="/download" tone="primary" size="lg">
              Download
            </ButtonLink>
            <ButtonLink href={WEB_APP} tone="ghost" size="lg">
              Open the web app
            </ButtonLink>
          </div>
          <p className="mt-4 text-sm text-muted">
            Free and open source. Uses the agent subscriptions you already have.
            macOS and Linux; iPhone, Android and the web to follow along.
          </p>
        </div>
        <div className="mt-14">
          <HeroDemo />
        </div>
      </Container>
    </div>
  );
}

function Overview() {
  return (
    <Section
      id="overview"
      title="One window for the whole change."
      intro="From the first message to the merged pull request: the agent writes, you steer from anywhere, you review what it did the way it was meant, and you ship."
    >
      <div className="mt-12 grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-4">
        <Fact icon={<CodeFork />} title="Spaces">
          Say what you want. An agent writes the change in its own copy of the
          repository, on its own branch, while you watch the live diff and chat.
        </Fact>
        <Fact icon={<Smartphone />} title="Phone and web">
          Follow every space, answer a question from the notification, start new
          work on any of your computers. From the train.
        </Fact>
        <Fact icon={<Eye />} title="Review by meaning">
          A pull request read as the steps it takes, each with a why, a risk and
          a checklist, not as files in alphabetical order.
        </Fact>
        <Fact icon={<Comment />} title="Agents in the loop">
          Ask about any line. Run review skills for bugs, security and tests.
          Turn a finding into a comment, a task or a fix.
        </Fact>
        <Fact icon={<ListUl />} title="One inbox">
          Review requests, assignments and mentions, with snooze until a push or
          until the checks go green.
        </Fact>
        <Fact icon={<CodeMerge />} title="Merge from here">
          Checks, conflicts computed against the base branch, merge, auto-merge
          or the merge queue. Comments go out as one review.
        </Fact>
        <Fact icon={<Keyboard />} title="Keyboard-first, local-first">
          ⌘K finds every action and PR. State lives on your disk; writes queue
          and go out when you're back online.
        </Fact>
        <Fact icon={<Persons />} title="GitHub, GitLab, Bitbucket">
          GitHub is the most complete. GitLab and Bitbucket Cloud are real,
          narrower adapters behind Labs.
        </Fact>
      </div>
    </Section>
  );
}

function Review() {
  return (
    <Section
      id="review"
      eyebrow="Review"
      title="Read a pull request as the steps it takes, not the files it touches."
      intro="A diff in file order hides the story: the model, the API that uses it and its tests sit far apart. Theodore has your agent regroup the diff by meaning, and keeps track of what you've read."
    >
      <div className="mt-12">
        <ReviewMock />
      </div>
      <div className="mt-12 grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-3">
        <Fact title="Grouped, with a why">
          Titled groups in reading order, each with why it is there, its risk
          and a checklist. A progress line counts the groups read; per-hunk read
          state survives a push.
        </Fact>
        <Fact title="After a push, only what changed">
          Revisions keep their place. The interdiff flags only new or changed
          hunks, with a view of what changed since you last looked.
        </Fact>
        <Fact title="Findings stay in the app">
          Skills run on the agent you pick and their findings land here, never
          on the PR. You turn the ones you agree with into draft comments, sent
          together as one review, or into tasks.
        </Fact>
        <Fact title="Ask, then send to the agent">
          Ask about a line, a group or the whole PR; the agent reads the diff. A
          finding can get a proposed fix; a reviewer's thread goes back to the
          agent in its space with one click.
        </Fact>
        <Fact title="Merge with the facts">
          Conflicts are computed locally against the base branch tip, checks are
          followed as they finish. Merge, enqueue, auto-merge or update the
          branch from the same header.
        </Fact>
        <Fact title="Code intelligence">
          ⌘-click an identifier for its definitions and references across the
          worktree. Colour literals get a swatch. Markdown and images diff as
          what they are.
        </Fact>
      </div>
    </Section>
  );
}

function Spaces() {
  return (
    <Section
      id="spaces"
      eyebrow="Spaces"
      title="One change, one space."
      intro="A space is a fresh worktree of your repository on its own branch. The agent works there, so your checkout stays untouched and several changes run at once. When it's good, the space becomes a pull request."
    >
      <div className="mt-12">
        <SpacesMock />
      </div>
      <div className="mt-12 grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-3">
        <Fact title="Its own agent, model and mode">
          Claude Code, Codex or Gemini CLI; the model and effort; Ask, Plan,
          Edit or Run. Picked per space, never touching your settings. Plan mode
          ends in a plan you approve before anything is written.
        </Fact>
        <Fact title="Every step in the open">
          A command's output, an edit's diff, a subagent's prompt and report:
          each row opens in place. Hover a file for its diff in that turn. Your
          project's setup, run and check commands run with the space.
        </Fact>
        <Fact title="Sub-spaces in parallel">
          An agent can split the work into sub-spaces, each in its own worktree,
          wait for them and merge them back. The sidebar shows the tree; one
          space can ask another what it knows.
        </Fact>
        <Fact title="Rewind">
          Every turn is a checkpoint. Undo the last one, or go back to any
          earlier reply: the worktree and the branch follow.
        </Fact>
        <Fact title="Review it like a PR, before it is one">
          The space's diff gets the same grouped review. A comment on a line
          becomes the agent's next turn with Send to agent.
        </Fact>
        <Fact title="Ship as a PR">
          Open PR squashes the turns into one commit by you on your own branch;
          later turns push to it, and reviewer threads come back to the agent.
          In a local folder, merge locally or keep the branch.
        </Fact>
      </div>
    </Section>
  );
}

function Fleet() {
  return (
    <Section
      id="cloud"
      eyebrow="Cloud spaces"
      title="Your phone is the remote. Your other computers do the work."
      intro="Theodore Code for iPhone, Android and the web follows the spaces on your computers. The Theodore cloud relays between your devices; the computers decide what runs."
    >
      <div className="mt-12">
        <FleetMock />
      </div>
      <div className="mt-12 grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-3">
        <Fact icon={<Bell />} title="Start, follow, answer">
          Start a space on any of your computers from the phone: pick the
          project, the computer, the model and the mode. Follow its turns live,
          send the next message, approve a plan, answer a question.
        </Fact>
        <Fact icon={<Smartphone />} title="Notifications that act">
          A question arrives as a push with its options as buttons: one tap
          answers it. A finished space tells you so. Questions go to where you
          are, and to the phone when you're away.
        </Fact>
        <Fact icon={<Persons />} title="Delegate a computer's spaces">
          Tell a computer to send its spaces' questions to your phone, or to
          another computer. Revoke it any time.
        </Fact>
        <Fact icon={<Cloud />} title="Spaces across your computers">
          Start a space on your Linux box from your Mac. An agent in a space can
          do the same: hand part of the work to another machine and wait for it.
        </Fact>
        <Fact icon={<Fingerprint />} title="Devices decide, the cloud relays">
          Every device has its own key. You compare fingerprints once and trust
          a device there. Every request, reply and event is signed, and a
          computer runs only what a device it trusts asked for, within the mode
          you allowed.
        </Fact>
        <Fact icon={<Shield />} title="Claude via cloud">
          Add Theodore as an MCP server in Claude Code or claude.ai and let
          Claude start and steer spaces on your computers. Every edit or command
          waits for your Allow, on the computer or your phone, unless you turn
          on auto mode for a while.
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
      <div className="mt-12 grid grid-cols-1 gap-8 sm:grid-cols-3">
        <Fact title="Your agents, your machine">
          Claude Code, Codex and Gemini CLI run on your computer, signed in to
          your own accounts. Theodore has no review server: your code goes only
          where your CLI already sends it.
        </Fact>
        <Fact title="Open source">
          The desktop and phone apps are MIT; the cloud is source-available
          under FSL and turns Apache 2.0 after two years. Read it, build it, or
          run the cloud yourself.
        </Fact>
        <Fact title="Honest about data">
          Diagnostics are off until you say yes, and redacted before they leave.
          The{' '}
          <Link href="/privacy" className="underline underline-offset-2">
            privacy policy
          </Link>{' '}
          says what the cloud sees.
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
    <Section id="start" title="Start a space, then go for a walk.">
      <div className="mt-8 flex flex-wrap gap-3">
        <ButtonLink href="/download" tone="primary" size="lg">
          Download Theodore
        </ButtonLink>
        <ButtonLink href={WEB_APP} tone="ghost" size="lg">
          Open the web app
        </ButtonLink>
      </div>
      <p className="mt-5 flex items-start gap-2 text-sm text-muted">
        <TriangleExclamation className="mt-0.5 size-4 shrink-0 text-warning" />
        You need git and at least one agent CLI installed and signed in: claude,
        codex or gemini.
      </p>
    </Section>
  );
}

export function Home() {
  return (
    <>
      <Hero />
      <Overview />
      <Review />
      <Spaces />
      <Fleet />
      <Open />
      <Cta />
    </>
  );
}
