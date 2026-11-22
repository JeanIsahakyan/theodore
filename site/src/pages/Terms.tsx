import { Link } from '../app/router';
import { Container, Prose } from '../components/ui';
import {
  CONTACT_EMAIL,
  GITHUB,
  ISSUES,
  CLOUD_LICENSE,
  LICENSE,
} from '../content/links';

export const TERMS_EFFECTIVE = 'November 21, 2026';

export function Terms() {
  return (
    <div className="py-14 md:py-20">
      <Container>
        <h1 className="text-4xl font-semibold tracking-tight md:text-5xl">
          Terms of use
        </h1>
        <p className="mt-2 text-muted">Effective {TERMS_EFFECTIVE}</p>
        <Prose>
          <p>
            These terms cover the Theodore apps and the hosted Theodore cloud,
            operated by the Theodore team ("we"). By using them you agree to these
            terms. If you don't, don't use them.
          </p>

          <h2>The software</h2>
          <p>
            Theodore (desktop) and Theodore Code (phone and web) are open source
            under the <a href={LICENSE}>MIT License</a>. The cloud's source code
            (<code>cloud/</code>) is under the{' '}
            <a href={CLOUD_LICENSE}>Functional Source License 1.1</a>{' '}
            (FSL-1.1-ALv2): you may read, change and run it, including for your
            own team, but not offer it as a competing commercial service; each
            version becomes Apache 2.0 two years after its release. The licenses
            govern the code and come without warranty. These terms add nothing
            to them and take nothing from them.
          </p>

          <h2>The hosted cloud</h2>
          <p>
            We run the Theodore cloud (sign-in, the relay between your devices,
            push notifications, the web app) as a free service for people using
            Theodore. It is provided as is and as available, with no promise of
            uptime or of keeping any particular feature. We may change, limit or
            stop it, and will try to say so in advance where we can. You can run
            the cloud yourself from the source code at any time.
          </p>

          <h2>Your account and your devices</h2>
          <ul>
            <li>
              You are responsible for your account, for the devices you trust
              and for the agents you let run on your computers. Theodore does
              what a trusted device asks within the mode you allowed; choose who
              to trust, and the auto modes you turn on, with care.
            </li>
            <li>
              Use the service only with your own devices and the organizations
              you belong to. Don't try to reach other people's devices or data,
              to interfere with the service, or to use it for anything unlawful.
            </li>
            <li>
              We may suspend or close accounts that abuse the service or harm
              others. You can delete your account in the app at any time.
            </li>
          </ul>

          <h2>Your content</h2>
          <p>
            Your code, messages and everything the agents produce stay yours. We
            claim no rights to them. To provide the service we relay and store
            what your devices send through the cloud, as described in the{' '}
            <Link href="/privacy">privacy policy</Link>.
          </p>

          <h2>Third parties</h2>
          <p>
            The agent CLIs (Claude Code, Codex, Gemini CLI), the code hosts
            (GitHub, GitLab, Bitbucket), WorkOS, Apple, Google, Expo and
            Cloudflare are separate services with their own terms. Using them
            through Theodore doesn't change that.
          </p>

          <h2>No warranty, limited liability</h2>
          <p>
            The software and the service are provided "as is", without
            warranties of any kind. Agents make mistakes: review what they
            change before you ship it. To the extent the law allows, we are not
            liable for any indirect, incidental or consequential damages, or for
            loss of data or code, arising from the software or the service.
            Nothing here limits rights that the law does not let us limit.
          </p>

          <h2>Changes</h2>
          <p>
            We may update these terms. The effective date above changes when we
            do, and the history is in the <a href={GITHUB}>repository</a>.
            Continuing to use the service after a change means you accept it.
          </p>

          <h2>Contact</h2>
          <p>
            Questions, or something wrong:{' '}
            <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>, or open an{' '}
            <a href={ISSUES}>issue on GitHub</a>.
          </p>
        </Prose>
      </Container>
    </div>
  );
}
