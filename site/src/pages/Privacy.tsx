/**
 * The privacy policy for Theodore (desktop), Theodore Code (phone and web)
 * and the Theodore cloud. The one the App Store listing links. Sources:
 * docs/cloud.md (what the cloud keeps, account deletion), docs/telemetry.md
 * (diagnostics), docs/mobile.md (push, kept on the phone). Keep it true when
 * data handling changes.
 */
import { Container, Prose } from '../components/ui';
import { CONTACT_EMAIL, DOC } from '../content/links';

export const PRIVACY_EFFECTIVE = 'November 25, 2026';

export function Privacy() {
  return (
    <div className="py-14 md:py-20">
      <Container>
        <h1 className="text-4xl font-semibold tracking-tight md:text-5xl">
          Privacy policy
        </h1>
        <p className="mt-2 text-muted">
          Theodore, Theodore Code and the Theodore cloud · Effective{' '}
          {PRIVACY_EFFECTIVE}
        </p>
        <Prose>
          <p>
            Theodore is a desktop app for macOS and Linux that runs AI coding
            agents on your own computers and helps you review pull requests.
            Theodore Code is its companion app for iPhone, Android and the web,
            and the Theodore cloud relays between your devices. This website,
            theodore.cloud, is part of the same service. This policy covers all
            of them. They are operated by the Theodore team ("we"). Contact:{' '}
            <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
          </p>
          <p>
            <strong>In short:</strong> your code stays on your computers. We
            keep what is needed to sign you in and to relay your spaces between
            your devices. There are no ads and no tracking, and we don't sell
            data. Diagnostics from the desktop app are off until you turn them
            on. You can delete your account in the app.
          </p>

          <h2>What stays on your computer</h2>
          <ul>
            <li>
              Your repositories, worktrees, diffs and the state of your reviews,
              in a SQLite database under your home directory.
            </li>
            <li>
              The tokens for GitHub, GitLab or Bitbucket and your Theodore
              session, in your system keychain (or a file only you can read, on
              Linux without a keychain). They are never sent to us.
            </li>
            <li>
              Everything the agents read and write. Claude Code, Codex and
              Gemini CLI run on your computer under your own accounts with
              Anthropic, OpenAI or Google; what you send them is governed by
              those providers' policies, not by this one. Theodore has no server
              that sees your code.
            </li>
            <li>
              A local log of what the app did, with secrets, emails and your
              home directory removed, and never the text of a diff, a file or a
              comment.
            </li>
          </ul>

          <h2>What the cloud sees, and why</h2>
          <p>
            The Theodore cloud exists so that your devices can find each other:
            a phone can follow a space on your Mac, a Mac can start a space on
            your Linux machine, and Claude via an MCP connector can reach your
            computers. Nothing in it is required to review pull requests on one
            computer.
          </p>
          <table>
            <thead>
              <tr>
                <th>Data</th>
                <th>Why</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <strong>Account</strong>: email, name, user id, organizations
                  and roles
                </td>
                <td>
                  Sign-in and organizations. Provided by WorkOS, our identity
                  provider. Every user gets a personal organization; team
                  organizations are optional.
                </td>
              </tr>
              <tr>
                <td>
                  <strong>Devices</strong>: a device name, its operating system,
                  the app version, its public key, and for computers the names
                  of the projects and agents you make available to your other
                  devices
                </td>
                <td>
                  Showing your devices to each other and checking that every
                  message really comes from one of them. The private key never
                  leaves the device.
                </td>
              </tr>
              <tr>
                <td>
                  <strong>Space content</strong>: the goals and messages you
                  send, the agents' replies, their questions and your answers,
                  space names and branch names, and the small signed envelopes
                  that carry them
                </td>
                <td>
                  Relaying spaces between your devices and keeping their recent
                  history, so a phone that opens later still sees what happened.
                </td>
              </tr>
              <tr>
                <td>
                  <strong>Push token</strong> and the notification text
                </td>
                <td>Telling you when an agent asks a question or finishes.</td>
              </tr>
              <tr>
                <td>
                  <strong>Requests from Claude via cloud</strong>: the device
                  key the cloud holds for your MCP connector, and the requests
                  it makes
                </td>
                <td>
                  Letting Claude Code or claude.ai start and steer spaces on
                  your computers, with your approval on each edit or command.
                </td>
              </tr>
            </tbody>
          </table>
          <p>
            Space content is <strong>not end-to-end encrypted</strong>: it is
            encrypted in transit (TLS) and stored on Cloudflare's
            infrastructure, where our service can read it. Every envelope is
            signed by the device that sent it, and the cloud checks the
            signature, so it can relay but never speak as one of your devices.
            Notifications carry the space name and the question (up to 180
            characters) and pass through Expo's push service and Apple or
            Google. The cloud's own logs record error kinds only, never a token,
            a message or an email.
          </p>

          <h2>What we don't do</h2>
          <ul>
            <li>
              Theodore Code and this website contain no analytics, advertising
              or crash-reporting SDKs and don't track you across apps or
              websites.
            </li>
            <li>
              We don't sell or rent personal data, and we don't use it for
              advertising.
            </li>
          </ul>

          <h2>Desktop diagnostics (optional)</h2>
          <p>
            The desktop app can send error reports (to New Relic) and usage
            events (to PostHog), but only after you choose to, in onboarding or
            in Settings, and each can be switched off at any time. Nothing is
            sent or queued before a choice is recorded. Before anything leaves
            your computer, secrets are removed, and code, paths, repository and
            branch names are dropped or hashed. Usage events are counts,
            durations and values from a fixed list, never text. Where you have
            agreed to the current terms, reports are tied to your Theodore
            account's opaque id; otherwise to a random install id. Your email,
            name and host login are never included. Details of every event:{' '}
            <a href={DOC('telemetry.md')}>docs/telemetry.md</a>.
          </p>
          <p>
            "Report a problem" opens a public GitHub issue under your own GitHub
            account, with exactly the text you previewed, and optionally the
            redacted log lines you chose to attach.
          </p>

          <h2>This website</h2>
          <p>
            theodore.cloud is a static site served by Cloudflare Pages, which
            keeps ordinary request logs. The download page asks GitHub's API for
            the latest release from your browser, so GitHub sees that request.
            Your theme choice is kept in your browser's local storage. There are
            no cookies.
          </p>

          <h2>How long we keep it</h2>
          <ul>
            <li>
              Space content: at most the newest 500 events per space, within a
              size budget. A space is deleted 30 days after its computer was
              last online.
            </li>
            <li>Pending requests, questions and approvals: minutes.</li>
            <li>
              Account, devices and push tokens: until you remove the device or
              delete your account.
            </li>
            <li>
              The phone keeps recent messages of up to 50 spaces locally;
              signing out clears them.
            </li>
          </ul>

          <h2>Deleting your account</h2>
          <p>
            Delete your account in the app: Settings → Account →{' '}
            <strong>Delete account</strong> in Theodore on your computer, or
            Settings → <strong>Delete account</strong> in Theodore Code on your
            phone. This permanently deletes your account at WorkOS and
            everything the Theodore cloud holds for you: devices, push tokens,
            spaces and their content, files in transit, organizations only you
            are in, connected MCP clients and your usage analytics.
            Organizations other people are in stay; you leave them. Data on your
            own computers (your code, projects and spaces) and your GitHub and
            agent accounts are not touched. You can also email us to delete your
            account.
          </p>

          <h2>Service providers</h2>
          <table>
            <thead>
              <tr>
                <th>Provider</th>
                <th>Role</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Cloudflare</td>
                <td>
                  Hosting the cloud, the web app and this website; storage
                </td>
              </tr>
              <tr>
                <td>WorkOS</td>
                <td>Sign-in, accounts, organizations</td>
              </tr>
              <tr>
                <td>Expo (650 Industries), Apple, Google</td>
                <td>Push notifications</td>
              </tr>
              <tr>
                <td>New Relic, PostHog</td>
                <td>Desktop diagnostics, only if you opt in</td>
              </tr>
              <tr>
                <td>GitHub</td>
                <td>
                  App downloads and updates, the latest version on this site;
                  GitHub sign-in and pull requests on the desktop
                </td>
              </tr>
            </tbody>
          </table>
          <p>
            These providers may process data in the United States and other
            countries.
          </p>

          <h2>Your rights</h2>
          <p>
            You can access, correct, export or delete your data, and object to
            its processing, by emailing us. Where the GDPR applies, we process
            data to provide the service you asked for (contract) and, for the
            optional diagnostics, with your consent. You may also complain to
            your local data protection authority.
          </p>

          <h2>Children</h2>
          <p>
            Theodore is a developer tool and not directed at children under 13
            (or 16 in the EEA). We don't knowingly collect their data.
          </p>

          <h2>Changes</h2>
          <p>
            If this policy changes, we update it here and change the effective
            date. For significant changes, we'll also tell you in the app.
          </p>
        </Prose>
      </Container>
    </div>
  );
}
