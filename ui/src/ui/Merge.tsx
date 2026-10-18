/**
 * Merge as on GitHub: method, commit message, gates, conflicts, auto-merge —
 * ported from the prototype's `MergeDialog`, now wired to the real
 * `merge_info` / `merge_pr` / `update_branch` commands (`FEATURES.hostWrites`).
 *
 * We still have no `conflicts` field on `PrSummary`/`PrDetail`, unlike the
 * prototype's `PR.conflicts` — `MergeInfo.state === 'dirty'` tells us *that*
 * there's a conflict, never which files. Rather than fabricate a fake
 * conflicting diff to look busy, this shows a plain note next to "Update
 * branch" (the one real action that can clear a `behind` or `dirty` state).
 * "Resolve with agent" has no backing command either way — kept disabled.
 */
import { useEffect, useState } from 'react';
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
import type { AgentId, MergeInfo, MergeMethod, PrId } from '../gen/contract';
import { mergePr, updateBranch } from '../actions';
import { api } from '../core/api';
import { useRootStore } from '../stores/context';
import { Btn, Spinner } from './bits';

const METHOD: Record<MergeMethod, string> = {
  squash: 'Squash and merge',
  merge: 'Create a merge commit',
  rebase: 'Rebase and merge',
};

const AGENTS: AgentId[] = ['claude', 'codex', 'gemini'];

const STATE_LABEL: Record<MergeInfo['state'], string> = {
  clean: 'Ready to merge',
  blocked: 'Blocked by required checks or reviews',
  behind: 'Out of date with the base branch',
  dirty: 'Has merge conflicts',
  unstable: 'Checks are still running',
  unknown: "GitHub hasn't finished checking yet",
};

interface Gate {
  ok: boolean;
  label: string;
}

/** Everything that stands between this PR and a merge, from data we actually have. */
function gatesFor(
  store: ReturnType<typeof useRootStore>,
  pr: PrId,
  info: MergeInfo | null,
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
  if (info && info.state !== 'clean' && info.state !== 'unknown') {
    gates.push({ ok: false, label: STATE_LABEL[info.state] });
  }
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
  const [info, setInfo] = useState<MergeInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [method, setMethod] = useState<MergeMethod>('squash');
  const [title, setTitle] = useState(summary ? `${summary.title}` : '');
  const [body, setBody] = useState('');
  const [resolveAgent, setResolveAgent] = useState<AgentId | null>(null);
  const [updating, setUpdating] = useState(false);
  const [merging, setMerging] = useState<'now' | 'auto' | 'queue' | null>(null);

  useEffect(() => {
    let live = true;
    void api
      .mergeInfo(pr)
      .then((i) => {
        if (!live) return;
        setInfo(i);
        if (i.allowed_methods.length && !i.allowed_methods.includes(method)) {
          setMethod(i.allowed_methods[0]!);
        }
      })
      .catch(
        (e) => live && setLoadError(e instanceof Error ? e.message : String(e)),
      );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pr]);

  if (!summary) return null;

  const local = summary.pr.repo.host === 'local';
  const gates = gatesFor(store, pr, info);
  const blocked = gates.filter((g) => !g.ok);
  const behindOrDirty = info?.state === 'behind' || info?.state === 'dirty';
  const canMergeNow = !local && !!info && blocked.length === 0;
  const allowedMethods = info?.allowed_methods ?? [];
  const slug = `${summary.pr.repo.owner}/${summary.pr.repo.name}#${summary.pr.number}`;

  const doMerge = (opts: { auto?: boolean; queue?: boolean }) => {
    const kind = opts.queue ? 'queue' : opts.auto ? 'auto' : 'now';
    setMerging(kind);
    void mergePr(store, {
      pr,
      method,
      title: method === 'squash' ? title : null,
      body: method === 'squash' ? body : null,
      auto: !!opts.auto,
      queue: !!opts.queue,
    })
      .then((ok) => {
        if (ok && !opts.queue) onClose();
      })
      .finally(() => setMerging(null));
  };

  const footer = local ? null : !info ? (
    <Spinner />
  ) : info.in_queue ? (
    <Btn tone="tertiary" icon={<CodeMerge />} isDisabled>
      Already in the merge queue
    </Btn>
  ) : (
    <div className="flex items-center gap-2">
      <Btn
        tone="tertiary"
        icon={<CodeMerge />}
        className="merge-queue"
        isPending={merging === 'queue'}
        onPress={() => doMerge({ queue: true })}
      >
        Add to merge queue
      </Btn>
      <Btn
        tone={info.auto_merge_enabled ? 'secondary' : 'tertiary'}
        icon={<CodeMerge />}
        className="enable-auto-merge"
        isPending={merging === 'auto'}
        onPress={() => doMerge({ auto: !info.auto_merge_enabled })}
      >
        {info.auto_merge_enabled ? 'Disable auto-merge' : 'Enable auto-merge'}
      </Btn>
      <Btn
        tone="success"
        icon={<CodeMerge />}
        className="do-merge"
        isDisabled={blocked.length > 0}
        isPending={merging === 'now'}
        onPress={() => doMerge({})}
      >
        {METHOD[method]}
      </Btn>
    </div>
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
            {loadError && (
              <Alert status="danger">
                <Alert.Indicator />
                <Alert.Content>
                  <Alert.Title>Can't check merge status</Alert.Title>
                  <Alert.Description>{loadError}</Alert.Description>
                </Alert.Content>
              </Alert>
            )}
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

            {behindOrDirty && (
              <Alert status="default" className="conflicts">
                <Alert.Indicator />
                <Alert.Content>
                  <Alert.Title>
                    {info?.state === 'dirty'
                      ? 'Merge conflicts — no file-level detail is reported yet'
                      : 'Behind the base branch'}
                  </Alert.Title>
                  <Alert.Description className="flex flex-wrap items-center gap-1.5">
                    {info?.state === 'dirty'
                      ? 'GitHub reports this PR has conflicts with the base branch.'
                      : 'Merge the base branch into this one to pick up its latest changes.'}
                    <Tooltip>
                      <Dropdown>
                        <Button
                          size="sm"
                          variant="tertiary"
                          className="resolve-agent"
                          isDisabled
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
                    <Button
                      size="sm"
                      variant="ghost"
                      isPending={updating}
                      onPress={() => {
                        setUpdating(true);
                        void updateBranch(store, pr).finally(() =>
                          setUpdating(false),
                        );
                      }}
                    >
                      Update branch
                    </Button>
                    {resolveAgent && (
                      <span className="text-xs text-muted">
                        picked {resolveAgent} — nothing to run yet
                      </span>
                    )}
                  </Alert.Description>
                </Alert.Content>
              </Alert>
            )}

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
                  isDisabled={
                    allowedMethods.length > 0 && !allowedMethods.includes(m)
                  }
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
                ? `Can't merge yet: ${blocked.map((g) => g.label.toLowerCase()).join('; ')}. Auto-merge will merge once everything is resolved.`
                : canMergeNow
                  ? 'All checks passed.'
                  : local
                    ? 'No PR to merge.'
                    : ''}
            </span>
          </Modal.Body>
          <Modal.Footer>{footer}</Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
});
