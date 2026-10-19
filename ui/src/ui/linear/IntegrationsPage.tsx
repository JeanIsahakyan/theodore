/** Settings → Integrations: connect/disconnect Linear. Read-only — this
 *  page only stores a personal API key and shows who it belongs to; the
 *  issue lookups it unlocks happen in Peek/Review (`LinearChips`). */
import { useEffect, useState } from 'react';
import { CircleCheckFill, Lock } from '@gravity-ui/icons';
import {
  Button,
  Card,
  Chip,
  Input,
  Label,
  Separator,
  TextField,
  Typography,
} from '@heroui/react';
import { observer } from 'mobx-react-lite';
import type { LinearStatus } from '../../gen/contract';
import { api, CommandFailure } from '../../core/api';

export const IntegrationsPage = observer(function IntegrationsPage() {
  const [status, setStatus] = useState<LinearStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setBusy(true);
    void api
      .linearStatus()
      .then(setStatus)
      .catch(() => setStatus(null))
      .finally(() => setBusy(false));
  };
  useEffect(load, []);

  const setToken_ = (value: string | null) => {
    setError(null);
    setBusy(true);
    void api
      .setLinearToken({ token: value })
      .then((s) => {
        setStatus(s);
        setEditing(false);
        setToken('');
      })
      .catch((e) =>
        setError(e instanceof CommandFailure ? e.message : String(e)),
      )
      .finally(() => setBusy(false));
  };

  return (
    <section className="flex flex-col gap-2">
      <Typography.Heading level={6}>Linear</Typography.Heading>
      <Card variant="secondary" className="gap-0 p-0">
        <div className="flex items-center gap-3 px-4 py-3">
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm font-medium">
              {status?.user ?? 'Not connected'}
              {status?.workspace && (
                <span className="text-muted"> · {status.workspace}</span>
              )}
            </span>
            <span className="text-xs text-muted">
              {status?.connected
                ? 'Issue keys in a PR title, branch or body are linked automatically'
                : 'Paste a personal API key to link PRs to Linear issues'}
            </span>
          </div>
          {status?.connected && (
            <Chip size="sm" variant="soft" color="success" className="gap-1">
              <CircleCheckFill className="size-3" /> connected
            </Chip>
          )}
        </div>
        <Separator />
        {editing ? (
          <div className="flex items-center gap-2 px-4 py-3">
            <TextField
              value={token}
              onChange={setToken}
              type="password"
              className="flex-1"
            >
              <Label className="sr-only">Linear personal API key</Label>
              <Input
                autoFocus
                placeholder="lin_api_…"
                className="font-mono text-sm"
              />
            </TextField>
            <Button
              size="sm"
              isDisabled={token.trim().length < 8}
              onPress={() => setToken_(token.trim())}
            >
              Save
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onPress={() => {
                setEditing(false);
                setToken('');
              }}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2 p-1">
            <Button
              variant="ghost"
              className="add-token m-1 justify-start gap-2"
              onPress={() => setEditing(true)}
            >
              <Lock className="size-4" />{' '}
              {status?.connected ? 'Replace API key' : 'Connect'}
            </Button>
            <Button
              variant="ghost"
              className="m-1 justify-start gap-2"
              isDisabled={busy}
              onPress={load}
            >
              Check again
            </Button>
            {status?.connected && (
              <Button
                variant="ghost"
                className="m-1 justify-start gap-2 text-danger"
                isDisabled={busy}
                onPress={() => setToken_(null)}
              >
                Disconnect
              </Button>
            )}
          </div>
        )}
      </Card>
      {error && <span className="text-xs text-danger">{error}</span>}
    </section>
  );
});
