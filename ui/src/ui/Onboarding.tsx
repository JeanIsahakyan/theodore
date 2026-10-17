import { useEffect, useState } from 'react';
import { Card, Typography } from '@heroui/react';
import { observer } from 'mobx-react-lite';
import { Sparkles } from '@gravity-ui/icons';
import type { AgentStatus } from '../gen/contract';
import { api } from '../core/api';
import { useUi } from '../stores/context';
import { Btn, Spinner } from './bits';

/**
 * First launch: detect the agent CLIs, show what was found, then into the
 * app. GitHub auth (device flow / PAT) is a later slice — this step stays a
 * placeholder so onboarding has a natural place for it once it exists.
 */
export const Onboarding = observer(function Onboarding() {
  const ui = useUi();
  const [agents, setAgents] = useState<AgentStatus[] | null>(null);
  useEffect(() => {
    void api.detectAgents().then(setAgents);
  }, []);
  return (
    <div className="flex h-full items-center justify-center bg-background p-8">
      <Card className="flex w-[480px] flex-col gap-5 p-8">
        <div className="flex flex-col gap-1">
          <Typography.Heading level={5}>Welcome to Theodore</Typography.Heading>
          <Typography.Paragraph size="sm" color="muted">
            Local AI agents regroup a pull request by meaning, so you read it as
            logical steps, not an alphabetical list of files.
          </Typography.Paragraph>
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">
            Agent CLIs on this machine
          </span>
          {!agents ? (
            <Spinner />
          ) : (
            <div className="flex flex-col gap-1.5">
              {agents.map((a) => (
                <div key={a.id} className="flex items-center gap-2 text-sm">
                  <Sparkles className="size-3.5 text-muted" />
                  <span className="font-mono">{a.id}</span>
                  <span className="flex-1" />
                  <span className="text-muted">
                    {a.installed ? (a.version ?? 'found') : 'not found'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* TODO: GitHub auth — device flow / `gh auth token` / PAT entry. A later slice. */}
        <div className="rounded-xl border border-dashed border-separator p-3 text-xs text-muted">
          GitHub sign-in comes in a later step. For now, open a PR by URL from
          the Inbox once you're in.
        </div>

        <Btn tone="primary" onPress={() => ui.finishOnboarding()}>
          Continue
        </Btn>
      </Card>
    </div>
  );
});
