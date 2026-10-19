import { useState } from 'react';
import { Copy } from '@gravity-ui/icons';
import { Alert, Button } from '@heroui/react';
import type { DeviceLoginState } from '../core/deviceLogin';
import { Spinner } from './bits';

/** The device-code step of GitHub's OAuth device flow: the code to type in,
 *  a copy button, a link to open the host's own verification page, and the
 *  pending/slow_down/denied/expired states while `useDeviceLogin` polls.
 *  Shared by Onboarding and Settings → Account. */
export function DeviceLoginPanel({ state }: { state: DeviceLoginState }) {
  const [copied, setCopied] = useState(false);
  const { phase, device, error, start, reset } = state;

  const copyCode = () => {
    if (!device) return;
    void navigator.clipboard.writeText(device.user_code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  if (phase === 'starting') {
    return (
      <div className="flex items-center gap-2 text-sm text-muted">
        <Spinner /> Starting device sign-in…
      </div>
    );
  }

  if (phase === 'pending' && device) {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <span className="font-mono text-2xl font-semibold tracking-[0.2em]">
            {device.user_code}
          </span>
          <Button size="sm" variant="ghost" onPress={copyCode}>
            <Copy className="size-4" />
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
        <div className="flex items-center gap-2 text-sm text-muted">
          <Spinner /> Waiting for confirmation on GitHub…
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            onPress={() => window.open(device.verification_uri, '_blank')}
          >
            Open github.com/login/device
          </Button>
          <Button size="sm" variant="ghost" onPress={reset}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  if (phase === 'denied') {
    return (
      <Alert status="danger">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Title>Sign-in denied</Alert.Title>
          <Alert.Description>
            The request was denied on GitHub.{' '}
            <Button size="sm" variant="ghost" className="px-1" onPress={start}>
              Try again
            </Button>
          </Alert.Description>
        </Alert.Content>
      </Alert>
    );
  }

  if (phase === 'expired') {
    return (
      <Alert status="warning">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Title>Code expired</Alert.Title>
          <Alert.Description>
            That code timed out.{' '}
            <Button size="sm" variant="ghost" className="px-1" onPress={start}>
              Get a new code
            </Button>
          </Alert.Description>
        </Alert.Content>
      </Alert>
    );
  }

  if (phase === 'error') {
    return (
      <div className="flex flex-col gap-2">
        <span className="text-xs text-danger">{error}</span>
        <Button size="sm" variant="ghost" className="self-start" onPress={start}>
          Retry
        </Button>
      </div>
    );
  }

  return null;
}
