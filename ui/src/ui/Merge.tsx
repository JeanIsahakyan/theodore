/**
 * Merge as on GitHub: method, commit message, gates, conflicts, auto-merge —
 * ported from the prototype's `MergeDialog`. We have no host-write command
 * for any of it yet (`FEATURES.hostWrites`, see `features.ts`): no merge,
 * no auto-merge toggle, no update-branch, no conflict resolution. Every
 * control that would call one of those stays on screen, disabled, with a
 * "Not available yet" tooltip — the moment the command lands, flip the flag
 * and these go live with no further UI work.
 *
 * We also have no `conflicts` field on `PrSummary`/`PrDetail` at all, unlike
 * the prototype's `PR.conflicts`. Rather than fabricate a fake conflicting
 * diff to look busy, this shows a plain note that conflict detection isn't
 * wired up, next to the (disabled) actions that would resolve one.
 */
import { useState } from 'react';
import {
  CircleCheckFill,
  CodeMerge,
  TriangleExclamation,
} from '@gravity-ui/icons';
import {
  Alert,
  Button,
  Dropdown,
  Input,
  Label,
  Modal,
  Radio,
  RadioGroup,
  TextArea,
  TextField,
  Tooltip,
} from '@heroui/react';
import { observer } from 'mobx-react-lite';
import type { AgentId, PrId } from '../gen/contract';
import { FEATURES } from '../features';
import { useRootStore } from '../stores/context';
import { Btn } from './bits';

type MergeMethod = 'squash' | 'merge' | 'rebase';

const METHOD: Record<MergeMethod, string> = {
  squash: 'Squash and merge',
  merge: 'Create a merge commit',
  rebase: 'Rebase and merge',
};

const AGENTS: AgentId[] = ['claude', 'codex', 'gemini'];

interface Gate {
  ok: boolean;
  label: string;
}

/** Everything that stands between this PR and a merge, from data we actually have. */
function gatesFor(
  store: ReturnType<typeof useRootStore>,
  pr: PrId,
): Gate[] {
  const summary = store.models.prSummaries.get(pr);
  const detail = store.models.prDetails.get(pr);
  const tasks = store.models.tasks.where((t) => t.pr === pr);
  const toVerify = tasks.filter((t) => t.status === 'review').length;
  const checks = detail?.checks ?? [];
  const failing = checks.filter((c) => c.status === 'fail').length;
  const pending = checks.filter((c) => c.status === 'pending').length;
  const gates: Gate[] = [];
  if (summary) {
    gates.push({
      ok: summary.state !== 'draft',
      label:
        summary.state === 'draft'
          ? 'Draft — needs "Ready for review"'
          : 'Open for review',
    });
    gates.push({
      ok: failing === 0,
      label: failing
        ? `${failing} ${failing === 1 ? 'check' : 'checks'} failing`
        : pending
          ? `${pending} ${pending === 1 ? 'check' : 'checks'} still running`
          : 'Checks passing',
    });
    gates.push({
      ok: summary.approvals >= (summary.required_approvals ?? 0),
      label: `${summary.approvals}/${summary.required_approvals ?? 0} approvals`,
    });
  }
  if (toVerify) gates.push({ ok: false, label: `${toVerify} tasks to verify` });
  return gates;
}

export const MergeDialog = observer(function MergeDialog({
  pr,
  onClose,
}: {
  pr: PrId;
  onClose: () => void;
}) {
  const store = useRootStore();
  const summary = store.models.prSummaries.get(pr);
  const [method, setMethod] = useState<MergeMethod>('squash');
  const [title, setTitle] = useState(summary ? `${summary.title}` : '');
  const [body, setBody] = useState('');
  const [resolveAgent, setResolveAgent] = useState<AgentId | null>(null);
  if (!summary) return null;

  const local = summary.pr.repo.host === 'local';
  const gates = gatesFor(store, pr);
  const blocked = gates.filter((g) => !g.ok);
  const mergeable = !local && blocked.length === 0;
  const slug = `${summary.pr.repo.owner}/${summary.pr.repo.name}#${summary.pr.number}`;

  const footer = blocked.length > 0 ? (
    <Tooltip>
      <Btn
        tone="tertiary"
        icon={<CodeMerge />}
        className="enable-auto-merge"
        isDisabled={!FEATURES.hostWrites}
        onPress={() => {}}
      >
        Enable auto-merge
      </Btn>
      <Tooltip.Content>Not available yet</Tooltip.Content>
    </Tooltip>
  ) : (
    <Tooltip>
      <Btn
        tone="success"
        icon={<CodeMerge />}
        className="do-merge"
        isDisabled={!FEATURES.hostWrites}
        onPress={() => {}}
      >
        {METHOD[method]}
      </Btn>
      <Tooltip.Content>Not available yet</Tooltip.Content>
    </Tooltip>
  );

  return (
    <Modal.Backdrop isOpen onOpenChange={(open) => !open && onClose()}>
      <Modal.Container
        size="lg"
        placement="top"
        scroll="inside"
        className="mt-[8vh]"
      >
        <Modal.Dialog className="modal w-[640px] max-w-[92vw]">
          <Modal.CloseTrigger />
          <Modal.Header className="modal-h">
            <Modal.Heading>Merge · {slug}</Modal.Heading>
          </Modal.Header>
          <Modal.Body className="flex flex-col gap-3">
            <div className="merge-gates flex flex-col gap-1.5 text-sm">
              {gates.map((g) => (
                <div
                  key={g.label}
                  className={`flex items-center gap-2 ${g.ok ? 'text-muted' : 'text-foreground'}`}
                >
                  {g.ok ? (
                    <CircleCheckFill className="size-4 text-success" />
                  ) : (
                    <TriangleExclamation className="size-4 text-warning" />
                  )}
                  {g.label}
                </div>
              ))}
              {local && (
                <div className="flex items-center gap-2 text-foreground">
                  <TriangleExclamation className="size-4 text-warning" />
                  Local branch — no host PR to merge
                </div>
              )}
            </div>

            <Alert status="default" className="conflicts">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Title>Conflict detection isn't wired up yet</Alert.Title>
                <Alert.Description className="flex flex-wrap items-center gap-1.5">
                  No command reports merge conflicts for this PR.
                  <Tooltip>
                    <Dropdown>
                      <Button
                        size="sm"
                        variant="tertiary"
                        className="resolve-agent"
                        isDisabled={!FEATURES.hostWrites}
                      >
                        Resolve with agent
                      </Button>
                      <Dropdown.Popover placement="bottom end">
                        <Dropdown.Menu
                          aria-label="Agent"
                          onAction={(k) => setResolveAgent(k as AgentId)}
                        >
                          {AGENTS.map((a) => (
                            <Dropdown.Item key={a} id={a} textValue={a}>
                              {a}
                            </Dropdown.Item>
                          ))}
                        </Dropdown.Menu>
                      </Dropdown.Popover>
                    </Dropdown>
                    <Tooltip.Content>Not available yet</Tooltip.Content>
                  </Tooltip>
                  <Tooltip>
                    <Button
                      size="sm"
                      variant="ghost"
                      isDisabled={!FEATURES.hostWrites}
                      onPress={() => {}}
                    >
                      Update branch
                    </Button>
                    <Tooltip.Content>Not available yet</Tooltip.Content>
                  </Tooltip>
                  {resolveAgent && !FEATURES.hostWrites && (
                    <span className="text-xs text-muted">
                      picked {resolveAgent} — nothing to run yet
                    </span>
                  )}
                </Alert.Description>
              </Alert.Content>
            </Alert>

            <RadioGroup
              value={method}
              onChange={(v) => setMethod(v as MergeMethod)}
              aria-label="Merge method"
              className="merge-method gap-1.5"
            >
              {(Object.keys(METHOD) as MergeMethod[]).map((m) => (
                <Radio
                  key={m}
                  value={m}
                  className={`rounded-2xl border px-3 py-2 ${method === m ? 'border-accent bg-accent-soft' : 'border-separator'}`}
                >
                  <Radio.Content>
                    <Radio.Control>
                      <Radio.Indicator />
                    </Radio.Control>
                    <div>
                      <b className="text-sm">{METHOD[m]}</b>
                      <div className="text-xs text-muted">
                        {m === 'squash'
                          ? 'one commit on main; branch history is squashed'
                          : m === 'merge'
                            ? 'all commits + a merge commit'
                            : 'branch commits on top of main, no merge commit'}
                      </div>
                    </div>
                  </Radio.Content>
                </Radio>
              ))}
            </RadioGroup>
            {method === 'squash' && (
              <>
                <TextField value={title} onChange={setTitle}>
                  <Label>Commit message</Label>
                  <Input className="font-mono text-xs" />
                </TextField>
                <TextArea
                  rows={3}
                  aria-label="Commit description"
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  className="font-mono text-xs"
                />
              </>
            )}
            <span className="text-xs text-muted">
              {blocked.length
                ? `Can't merge yet: ${blocked.map((g) => g.label.toLowerCase()).join('; ')}.`
                : mergeable
                  ? 'All checks passed.'
                  : 'No PR to merge.'}
            </span>
          </Modal.Body>
          <Modal.Footer>{footer}</Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
});
