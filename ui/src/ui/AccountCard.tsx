import { useEffect, useState } from 'react';
import {
  ArrowRightFromSquare,
  Copy,
  Envelope,
  Person,
} from '@gravity-ui/icons';
import {
  Alert,
  Button,
  Card,
  Input,
  Label,
  Separator,
  TextField,
  Typography,
} from '@heroui/react';
import { observer } from 'mobx-react-lite';
import type { AccountStatus, AccountUser } from '../gen/contract';
import { api } from '../core/api';
import { accountLabel, looksLikeEmail } from '../core/accountFlow';
import { useAccountSignIn, type AccountSignIn } from '../core/accountSignIn';
import { useRootStore } from '../stores/context';
import { Avatar, Spinner } from './bits';

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
        // the card stays hidden
      });
    return () => {
      live = false;
    };
  }, [store]);
  return store.ephemeral.account;
}

/** The sign-in itself: email → hosted page in the browser (code by email,
 *  or any other method enabled there), or a code to confirm on the web.
 *  Shared by Settings → Account and Onboarding. */
export function AccountSignInPanel({
  signIn,
  compact = false,
}: {
  signIn: AccountSignIn;
  compact?: boolean;
}) {
  const { flow, start, cancel, reopen } = signIn;
  const [email, setEmail] = useState('');
  const [copied, setCopied] = useState(false);

  const copyCode = () => {
    if (!flow.device) return;
    void navigator.clipboard.writeText(flow.device.userCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  if (flow.phase === 'starting') {
    return (
      <div className="flex items-center gap-2 text-sm text-muted">
        <Spinner />
        {flow.method === 'browser'
          ? 'Opening your browser…'
          : 'Getting a sign-in code…'}
        <Button size="sm" variant="ghost" onPress={cancel}>
          Cancel
        </Button>
      </div>
    );
  }

  if (flow.phase === 'browser') {
    return (
      <div className="account-browser-wait flex flex-col gap-3">
        <div className="flex items-center gap-2 text-sm">
          <Spinner /> Finish signing in in your browser…
        </div>
        <span className="text-xs text-muted">
          Enter the code we emailed you on that page. Theodore picks the sign-in
          up as soon as you're done.
        </span>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onPress={reopen}>
            Open the page again
          </Button>
          <Button size="sm" variant="ghost" onPress={cancel}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  if (flow.phase === 'device' && flow.device) {
    const d = flow.device;
    return (
      <div className="account-device-wait flex flex-col gap-3">
        <span className="text-xs text-muted">
          Open the page below on any device, sign in, and confirm this code:
        </span>
        <div className="flex items-center gap-3">
          <span className="font-mono text-2xl font-semibold tracking-[0.2em]">
            {d.userCode}
          </span>
          <Button size="sm" variant="ghost" onPress={copyCode}>
            <Copy className="size-4" />
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
        <div className="flex items-center gap-2 text-sm text-muted">
          <Spinner /> Waiting for confirmation…
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            onPress={() =>
              window.open(
                d.verificationUriComplete ?? d.verificationUri,
                '_blank',
              )
            }
          >
            Open {d.verificationUri.replace(/^https?:\/\//, '')}
          </Button>
          <Button size="sm" variant="ghost" onPress={cancel}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  const retry = () => start(flow.method ?? 'browser', email);

  if (flow.phase === 'denied' || flow.phase === 'expired') {
    return (
      <Alert status="warning">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Title>
            {flow.phase === 'denied'
              ? 'Sign-in cancelled'
              : 'Sign-in timed out'}
          </Alert.Title>
          <Alert.Description>
            {flow.phase === 'denied'
              ? 'The request was declined on the sign-in page.'
              : 'That sign-in waited too long.'}{' '}
            <Button size="sm" variant="ghost" className="px-1" onPress={retry}>
              Try again
            </Button>
            <Button size="sm" variant="ghost" className="px-1" onPress={cancel}>
              Back
            </Button>
          </Alert.Description>
        </Alert.Content>
      </Alert>
    );
  }

  if (flow.phase === 'error') {
    return (
      <div className="flex flex-col gap-2">
        <span className="text-xs text-danger">{flow.error}</span>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onPress={retry}>
            Retry
          </Button>
          <Button size="sm" variant="ghost" onPress={cancel}>
            Back
          </Button>
        </div>
      </div>
    );
  }

  // idle (and `done`, until the parent swaps in the signed-in state)
  const valid = looksLikeEmail(email);
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) start('browser', email);
      }}
    >
      <div className="flex items-end gap-2">
        <TextField
          value={email}
          onChange={setEmail}
          type="email"
          className="flex-1"
        >
          <Label className={compact ? 'sr-only' : undefined}>Email</Label>
          <Input
            placeholder="you@company.com"
            autoComplete="email"
            className="text-sm"
          />
        </TextField>
        <Button type="submit" size="sm" isDisabled={!valid}>
          <Envelope className="size-4" /> Email me a code
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-x-1 text-xs text-muted">
        <Button
          size="sm"
          variant="ghost"
          className="account-sign-in-browser px-1"
          onPress={() => start('browser')}
        >
          Other sign-in options
        </Button>
        ·
        <Button
          size="sm"
          variant="ghost"
          className="account-sign-in-device px-1"
          onPress={() => start('device_code')}
        >
          Sign in on another device
        </Button>
      </div>
    </form>
  );
}

/** Settings → Account: the "Theodore account" card, above the host cards.
 *  Hidden while the feature isn't configured (no WorkOS client id). */
export const AccountCard = observer(function AccountCard() {
  const store = useRootStore();
  const status = useAccountStatus();
  const signIn = useAccountSignIn((s) => store.ephemeral.setAccount(s));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!status?.available) return null;
  const user = status.user;

  const signOut = () => {
    setBusy(true);
    setError(null);
    void api
      .accountSignOut()
      .then((s) => {
        store.ephemeral.setAccount(s);
        signIn.cancel();
      })
      .catch((e) => setError(String(e?.message ?? e)))
      .finally(() => setBusy(false));
  };

  return (
    <section className="account-card flex flex-col gap-2">
      <Typography.Heading level={6}>Theodore account</Typography.Heading>
      <Card variant="secondary" className="gap-0 p-0">
        <div className="flex items-center gap-3 px-4 py-3">
          {user ? (
            <AccountAvatar user={user} size={28} />
          ) : (
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-default">
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
                : 'Optional. For sync, teams and licensing as they arrive. Hosts stay connected separately below.'}
            </span>
          </div>
        </div>
        <Separator />
        {user ? (
          <div className="flex items-center gap-2 p-1">
            <Button
              variant="ghost"
              className="account-sign-out m-1 justify-start gap-2 text-danger"
              isDisabled={busy}
              onPress={signOut}
            >
              <ArrowRightFromSquare className="size-4" /> Sign out
            </Button>
          </div>
        ) : (
          <div className="px-4 py-3">
            <AccountSignInPanel signIn={signIn} compact />
          </div>
        )}
      </Card>
      {error && <span className="text-xs text-danger">{error}</span>}
    </section>
  );
});

/** Onboarding's optional step body: the same sign-in, or who you are once
 *  signed in. */
export const AccountStep = observer(function AccountStep() {
  const store = useRootStore();
  const status = useAccountStatus();
  const signIn = useAccountSignIn((s) => store.ephemeral.setAccount(s));
  const user = status?.user;
  return (
    <>
      <Typography.Heading level={4}>Theodore account</Typography.Heading>
      <Typography.Paragraph size="sm" color="muted">
        Optional — skip it and everything works the same. Signing in gets you
        sync, teams and licensing as they arrive. Your code host stays connected
        separately.
      </Typography.Paragraph>
      {user ? (
        <Alert status="success">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title className="flex items-center gap-2">
              <AccountAvatar user={user} size={18} />
              Signed in as {accountLabel(user)}
            </Alert.Title>
            {user.name && <Alert.Description>{user.email}</Alert.Description>}
          </Alert.Content>
        </Alert>
      ) : (
        <AccountSignInPanel signIn={signIn} />
      )}
    </>
  );
});
