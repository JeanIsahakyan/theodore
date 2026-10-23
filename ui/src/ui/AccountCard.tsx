import { useEffect, useState, type ReactNode } from 'react';
import {
  ArrowRightFromSquare,
  ArrowUpRightFromSquare,
  CircleCheckFill,
  Copy,
  Display,
  Envelope,
  Person,
} from '@gravity-ui/icons';
import {
  Button,
  Card,
  Input,
  Label,
  Modal,
  TextField,
  Typography,
} from '@heroui/react';
import { observer } from 'mobx-react-lite';
import type { AccountStatus, AccountUser } from '../gen/contract';
import { api } from '../core/api';
import {
  accountLabel,
  looksLikeEmail,
  signInErrorText,
} from '../core/accountFlow';
import { useAccountSignIn, type AccountSignIn } from '../core/accountSignIn';
import { useRootStore, useUi } from '../stores/context';
import { Avatar, Spinner } from './bits';
import { Logo } from './Logo';

function AccountAvatar({ user, size }: { user: AccountUser; size: number }) {
  return (
    <Avatar
      person={{
        login: user.email,
        name: user.name,
        avatar_url: user.avatar_url,
      }}
      size={size}
    />
  );
}

/** Loads `account_status` into the store once per mount; the
 *  `account_status` event keeps it current afterwards. */
export function useAccountStatus(): AccountStatus | null {
  const store = useRootStore();
  useEffect(() => {
    let live = true;
    void api
      .accountStatus()
      .then((s) => live && store.ephemeral.setAccount(s))
      .catch(() => {
        // the sign-in stays hidden
      });
    return () => {
      live = false;
    };
  }, [store]);
  return store.ephemeral.account;
}

/** One centred stage of the sign-in: a mark, a title, a line, then the
 *  stage's own controls. Every stage has the same shape, so the dialog
 *  doesn't jump as the sign-in moves along. */
function Stage({
  mark,
  title,
  text,
  children,
}: {
  mark: ReactNode;
  title: string;
  text?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="stage flex w-full flex-col items-center gap-5 text-center [&_button]:w-full">
      {mark && <div className="grid size-12 place-items-center">{mark}</div>}
      <div className="flex w-full flex-col items-center gap-1.5">
        <Typography.Heading level={4} className="text-center">
          {title}
        </Typography.Heading>
        {text && (
          <Typography.Paragraph size="sm" color="muted" className="text-center">
            {text}
          </Typography.Paragraph>
        )}
      </div>
      {children && (
        <div className="flex w-full flex-col items-stretch gap-2">
          {children}
        </div>
      )}
    </div>
  );
}

const roundMark = (icon: ReactNode, tone = 'text-muted') => (
  <span
    className={`grid size-12 place-items-center rounded-full bg-default ${tone} [&>svg]:size-5`}
  >
    {icon}
  </span>
);

/** The sign-in itself, stage by stage: email → hosted page in the browser
 *  (the code is typed there; Theodore picks the sign-in up), or a code to
 *  confirm on another device. Shared by the sign-in dialog and Onboarding. */
export function SignInView({
  signIn,
  user,
  logo = true,
}: {
  signIn: AccountSignIn;
  user: AccountUser | null;
  /** Off where the logo is already on screen (Onboarding's header). */
  logo?: boolean;
}) {
  const { flow, start, cancel, reopen } = signIn;
  const [email, setEmail] = useState('');
  const [copied, setCopied] = useState(false);

  if (user) {
    return (
      <Stage
        mark={roundMark(<CircleCheckFill />, 'text-success')}
        title="You're in"
        text={
          <span className="inline-flex items-center gap-1.5">
            <AccountAvatar user={user} size={18} />
            {accountLabel(user)}
          </span>
        }
      />
    );
  }

  if (flow.phase === 'starting') {
    return (
      <Stage
        mark={roundMark(<Spinner />)}
        title={
          flow.method === 'device_code'
            ? 'Getting a code…'
            : 'Opening your browser…'
        }
      >
        <Button variant="ghost" onPress={cancel}>
          Cancel
        </Button>
      </Stage>
    );
  }

  if (flow.phase === 'browser') {
    return (
      <Stage
        mark={roundMark(<Envelope />)}
        title={email ? 'Check your email' : 'Finish in your browser'}
        text={
          email ? (
            <>
              We sent a code to <b className="text-foreground">{email}</b>.
              Enter it on the page that opened in your browser — Theodore signs
              you in as soon as you do.
            </>
          ) : (
            'Sign in on the page that opened in your browser — Theodore picks it up as soon as you do.'
          )
        }
      >
        <div className="flex items-center justify-center gap-2 py-1 text-sm text-muted">
          <Spinner /> Waiting for the browser…
        </div>
        <Button variant="secondary" onPress={reopen}>
          <ArrowUpRightFromSquare className="size-4" /> Open the page again
        </Button>
        <Button variant="ghost" onPress={cancel}>
          Use a different email
        </Button>
      </Stage>
    );
  }

  if (flow.phase === 'device' && flow.device) {
    const d = flow.device;
    const copy = () => {
      void navigator.clipboard.writeText(d.userCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    };
    return (
      <Stage
        mark={roundMark(<Display />)}
        title="Sign in on another device"
        text={
          <>
            Open{' '}
            <b className="text-foreground">
              {d.verificationUri.replace(/^https?:\/\//, '')}
            </b>{' '}
            anywhere, sign in, and confirm this code:
          </>
        }
      >
        <button
          type="button"
          onClick={copy}
          title="Copy"
          className="rounded-xl bg-default py-3 font-mono text-3xl font-semibold tracking-[0.25em] tabular-nums"
        >
          {d.userCode}
        </button>
        <div className="flex items-center justify-center gap-2 py-1 text-sm text-muted">
          <Spinner /> Waiting for confirmation…
        </div>
        <Button
          variant="primary"
          onPress={() =>
            window.open(
              d.verificationUriComplete ?? d.verificationUri,
              '_blank',
            )
          }
        >
          <ArrowUpRightFromSquare className="size-4" /> Open the page
        </Button>
        <Button variant="ghost" onPress={copy}>
          <Copy className="size-4" /> {copied ? 'Copied' : 'Copy code'}
        </Button>
        <Button variant="ghost" onPress={cancel}>
          Back
        </Button>
      </Stage>
    );
  }

  if (
    flow.phase === 'denied' ||
    flow.phase === 'expired' ||
    flow.phase === 'error'
  ) {
    const title =
      flow.phase === 'denied'
        ? 'Sign-in cancelled'
        : flow.phase === 'expired'
          ? 'Sign-in timed out'
          : "Couldn't sign in";
    const raw = flow.error ?? '';
    const words = signInErrorText(raw);
    const text =
      flow.phase === 'denied' ? (
        'The request was declined on the sign-in page.'
      ) : flow.phase === 'expired' ? (
        'That sign-in waited too long.'
      ) : (
        <>
          {words}
          {/* The service's own words, for whoever has to fix it. */}
          {words !== raw && (
            <span className="mt-2 block font-mono text-[11px] text-muted [overflow-wrap:anywhere]">
              {raw}
            </span>
          )}
        </>
      );
    return (
      <Stage
        mark={roundMark(<Person />, 'text-danger')}
        title={title}
        text={text}
      >
        <Button
          variant="primary"
          onPress={() => start(flow.method ?? 'browser', email)}
        >
          Try again
        </Button>
        <Button variant="ghost" onPress={cancel}>
          Back
        </Button>
      </Stage>
    );
  }

  // idle (and `done`, until the account status arrives)
  const valid = looksLikeEmail(email);
  return (
    <Stage
      mark={logo ? <Logo size={44} /> : null}
      title="Sign in to Theodore"
      text="Optional — your code hosts stay connected."
    >
      <form
        className="flex w-full flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) start('browser', email);
        }}
      >
        <TextField
          value={email}
          onChange={setEmail}
          type="email"
          aria-label="Email"
          autoFocus
        >
          <Label className="sr-only">Email</Label>
          <Input placeholder="you@company.com" autoComplete="email" />
        </TextField>
        <Button
          type="submit"
          variant="primary"
          isDisabled={!valid}
          className="account-sign-in-email"
        >
          Continue with email
        </Button>
      </form>
      <div className="flex items-center gap-3 py-1 text-xs text-muted">
        <span className="h-px flex-1 bg-separator" />
        or
        <span className="h-px flex-1 bg-separator" />
      </div>
      <Button
        variant="secondary"
        className="account-sign-in-browser"
        onPress={() => start('browser')}
      >
        <ArrowUpRightFromSquare className="size-4" /> Continue in browser
      </Button>
      <Button
        variant="ghost"
        className="account-sign-in-device"
        onPress={() => start('device_code')}
      >
        Sign in on another device
      </Button>
    </Stage>
  );
}

/** The sign-in dialog (`ui.openModal('sign-in')`): no title bar, just the
 *  stages. Closing it drops a sign-in in progress; it closes itself a
 *  moment after "You're in". */
export const SignInModal = observer(function SignInModal() {
  const store = useRootStore();
  const ui = useUi();
  const status = useAccountStatus();
  const signIn = useAccountSignIn((s) => store.ephemeral.setAccount(s));
  const user = status?.user ?? null;
  const waiting = signIn.flow.phase !== 'idle' && signIn.flow.phase !== 'done';

  useEffect(() => {
    if (!user) return;
    const t = setTimeout(() => ui.closeModal(), 1200);
    return () => clearTimeout(t);
  }, [user, ui]);

  const close = () => {
    if (waiting) signIn.cancel();
    ui.closeModal();
  };

  return (
    <Modal.Backdrop isOpen onOpenChange={(open) => !open && close()}>
      <Modal.Container placement="center">
        <Modal.Dialog
          aria-label="Sign in to Theodore"
          className="modal sign-in w-[380px] max-w-[92vw] px-8 pb-8 pt-10"
        >
          <Modal.CloseTrigger aria-label="Close" />
          <SignInView signIn={signIn} user={user} />
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
});

/** Settings → Account: one row for the Theodore account, above the host
 *  cards — who you are and Sign out, or a Sign in button that opens the
 *  dialog. Hidden while the feature isn't configured (no client id). */
export const AccountCard = observer(function AccountCard() {
  const store = useRootStore();
  const ui = useUi();
  const status = useAccountStatus();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!status?.available) return null;
  const user = status.user;

  const signOut = () => {
    setBusy(true);
    setError(null);
    void api
      .accountSignOut()
      .then((s) => store.ephemeral.setAccount(s))
      .catch((e) => setError(String(e?.message ?? e)))
      .finally(() => setBusy(false));
  };

  return (
    <section className="account-card flex flex-col gap-2">
      <Typography.Heading level={6}>Theodore account</Typography.Heading>
      <Card
        variant="secondary"
        className="flex-row items-center gap-3 px-4 py-3"
      >
        {user ? (
          <AccountAvatar user={user} size={28} />
        ) : (
          <span className="grid size-7 shrink-0 place-items-center rounded-full bg-default">
            <Person className="size-4 text-muted" />
          </span>
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium">
            {user ? accountLabel(user) : 'Not signed in'}
          </span>
          <span className="truncate text-xs text-muted">
            {user
              ? user.name
                ? user.email
                : 'Signed in'
              : 'Optional — for sync and teams as they arrive'}
          </span>
        </div>
        {user ? (
          <Button
            size="sm"
            variant="ghost"
            className="account-sign-out text-danger"
            isDisabled={busy}
            onPress={signOut}
          >
            <ArrowRightFromSquare className="size-4" /> Sign out
          </Button>
        ) : (
          <Button
            size="sm"
            variant="primary"
            className="account-sign-in"
            onPress={() => ui.openModal('sign-in')}
          >
            Sign in
          </Button>
        )}
      </Card>
      {error && <span className="text-xs text-danger">{error}</span>}
    </section>
  );
});

/** Onboarding's optional step body: the same stages as the dialog. */
export const AccountStep = observer(function AccountStep() {
  const store = useRootStore();
  const status = useAccountStatus();
  const signIn = useAccountSignIn((s) => store.ephemeral.setAccount(s));
  return (
    <div className="mx-auto w-full max-w-[340px] py-4">
      <SignInView signIn={signIn} user={status?.user ?? null} logo={false} />
    </div>
  );
});
