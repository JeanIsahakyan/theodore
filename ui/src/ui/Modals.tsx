import { useState } from 'react';
import {
  Alert,
  Button,
  Label,
  Radio,
  RadioGroup,
  Table,
  TextArea,
} from '@heroui/react';
import { observer } from 'mobx-react-lite';
import type { ReviewEvent } from '../gen/contract';
import { submitReview } from '../actions';
import { FEATURES } from '../features';
import { useRootStore, useUi } from '../stores/context';
import { AgentTag, K, Shell } from './bits';
import { AssignMenu, CommandMenu, SnoozeMenu } from './Palette';
import { AddProjectModal } from './Projects';

const EVENT_OPTS: [ReviewEvent, string, string][] = [
  ['COMMENT', 'Comment', 'no verdict'],
  ['APPROVE', 'Approve', 'ready to merge'],
  ['REQUEST_CHANGES', 'Request changes', 'blocks merge'],
];

const SubmitReviewModal = observer(function SubmitReviewModal() {
  const store = useRootStore();
  const ui = useUi();
  const [event, setEvent] = useState<ReviewEvent>('COMMENT');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  if (ui.route.name !== 'review') return null;
  const pr = ui.route.pr;
  const local = store.models.prSummaries.get(pr)?.pr.repo.host === 'local';
  const drafts = store.models.drafts.byPr(pr);
  const reads = new Set(store.models.hunkReads.byPr(pr).map((r) => r.hunk));
  // This PR's groups only — `groups.all()` spans every open PR.
  const unread = store.models
    .groupsOf(pr)
    .filter((g) => g.kind !== 'hidden')
    .flatMap((g) => g.hunks)
    .filter((h) => !reads.has(h)).length;
  return (
    <Shell
      title={`Review · ${prLabel(store.models.prSummaries.get(pr), pr)}`}
      size="lg"
      onClose={() => ui.closeModal()}
    >
      {unread > 0 && (
        <div className="text-xs text-warning">Unread hunks: {unread}</div>
      )}
      <TextArea
        rows={3}
        fullWidth
        aria-label="Overall comment"
        placeholder="Overall comment (optional)"
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      {local ? (
        <Alert status="accent">
          <Alert.Content>
            <Alert.Title>Local review — comments stay in Theodore.</Alert.Title>
            <Alert.Description>
              No host to send a verdict to; pending comments below are kept
              here.
            </Alert.Description>
          </Alert.Content>
        </Alert>
      ) : (
        <RadioGroup
          value={event}
          onChange={(v) => setEvent(v as ReviewEvent)}
          orientation="horizontal"
          aria-label="Verdict"
        >
          {EVENT_OPTS.map(([v, t, d]) => (
            <Radio
              key={v}
              value={v}
              className={`event flex-1 rounded-2xl border p-2.5 ${event === v ? 'border-accent bg-accent-soft' : 'border-separator'}`}
            >
              <Radio.Content>
                <Radio.Control>
                  <Radio.Indicator />
                </Radio.Control>
                <div>
                  <b>{t}</b>
                  <div className="text-xs text-muted">{d}</div>
                </div>
              </Radio.Content>
            </Radio>
          ))}
        </RadioGroup>
      )}
      <Label className="text-sm font-medium">
        Pending comments ({drafts.length})
      </Label>
      <Table variant="secondary">
        <Table.ScrollContainer>
          <Table.Content aria-label="Pending comments">
            <Table.Header>
              <Table.Column isRowHeader>where</Table.Column>
              <Table.Column>who</Table.Column>
              <Table.Column>text</Table.Column>
            </Table.Header>
            <Table.Body
              renderEmptyState={() => (
                <span className="text-xs text-muted">
                  none: only the verdict will be sent
                </span>
              )}
            >
              {drafts.map((d) => (
                <Table.Row key={d.id} id={d.id}>
                  <Table.Cell className="max-w-[200px] font-mono text-xs">
                    <span
                      className="block truncate"
                      title={`${d.anchor.path}:${d.anchor.line}`}
                    >
                      {d.anchor.path}:{d.anchor.line}
                    </span>
                  </Table.Cell>
                  <Table.Cell className="shrink-0">
                    {d.source.kind === 'agent' ? (
                      <AgentTag id={d.source.agent} />
                    ) : (
                      <span className="text-xs text-muted">you</span>
                    )}
                  </Table.Cell>
                  <Table.Cell className="max-w-[320px] text-xs">
                    <span className="line-clamp-2">{d.body.slice(0, 110)}</span>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Content>
        </Table.ScrollContainer>
      </Table>
      <div className="flex justify-end gap-2">
        <Button variant="tertiary" onPress={() => ui.closeModal()}>
          Cancel
        </Button>
        <Button
          variant={!local && event === 'REQUEST_CHANGES' ? 'danger' : 'primary'}
          isDisabled={sending}
          onPress={() => {
            setSending(true);
            void submitReview(store, pr, local ? 'COMMENT' : event, body.trim())
              .catch(() => {
                // toasted by api.ts
              })
              .finally(() => setSending(false));
            ui.closeModal();
            ui.goBack();
          }}
        >
          {sending ? 'Sending…' : local ? 'Done' : 'Submit'}
        </Button>
      </div>
    </Shell>
  );
});

const KEYS: [string, string][] = [
  ['Everywhere', ''],
  ['⌘K', 'command palette: any action, any PR'],
  [
    `G I${FEATURES.currentUser ? ' / G M' : ''} / G T / G S`,
    `Inbox${FEATURES.currentUser ? ' / My PRs' : ''} / Tasks / Settings`,
  ],
  ['[', 'collapse sidebar'],
  ['⌥1…9 / ⌥W', 'switch / close tab'],
  ['⌃1…9 / ⌃0', 'switch project / All projects'],
  ['⌘Z / ⌘⇧Z', 'undo / redo'],
  ['PR lists', ''],
  ['J / K', 'move through list'],
  ['⏎', 'open PR'],
  ['Space', 'peek: preview without opening'],
  ['X', 'select (bulk actions)'],
  ['E', 'done: leaves Inbox until new activity'],
  ['H', 'snooze: an hour, until next push, until checks pass'],
  ['Tasks', ''],
  ['Y', 'accept fix'],
  ['A', 'assign to a person or agent'],
  ['Review', ''],
  ['J / K', 'next / previous hunk'],
  ['N', 'next group'],
  ['R', 'mark group as read (in tour: next)'],
  ['V', 'Viewed for focused file'],
  ['C', 'comment on focused hunk'],
  ['T', 'toggle tour'],
  ['S', 'unified / side by side'],
  [']', 'hide / show AI panel'],
  ['⇧ + click +', 'comment on a line range'],
  [
    '⌘ + click symbol',
    FEATURES.symbolPeek
      ? 'definition and usages'
      : 'definition and usages (not available yet)',
  ],
  ['/', 'ask AI'],
  ['Esc', 'close / back'],
];

function HelpModalInner() {
  const ui = useUi();
  return (
    <Shell title="Shortcuts" onClose={() => ui.closeModal()}>
      <Table variant="secondary">
        <Table.ScrollContainer>
          <Table.Content aria-label="Shortcuts">
            <Table.Header>
              <Table.Column isRowHeader>shortcut</Table.Column>
              <Table.Column>action</Table.Column>
            </Table.Header>
            <Table.Body>
              {KEYS.map(([k, v], i) => (
                <Table.Row key={i} id={i}>
                  <Table.Cell>
                    {v ? (
                      <K>{k}</K>
                    ) : (
                      <b className="text-sm font-medium">{k}</b>
                    )}
                  </Table.Cell>
                  <Table.Cell>{v}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Content>
        </Table.ScrollContainer>
      </Table>
    </Shell>
  );
}

/** "migratro #77" for a host PR, the branch for a branch review. */
function prLabel(
  p:
    | {
        pr: { repo: { name: string }; number: number };
        url: string;
        head_ref: string;
      }
    | undefined,
  id: string,
): string {
  if (!p) return id;
  return p.url ? `${p.pr.repo.name} #${p.pr.number}` : p.head_ref;
}

export const Modals = observer(function Modals() {
  const ui = useUi();
  switch (ui.modal) {
    case 'cmdk':
      return <CommandMenu />;
    case 'snooze':
      return <SnoozeMenu />;
    case 'assign':
      return <AssignMenu />;
    case 'submit':
      return <SubmitReviewModal />;
    case 'help':
      return <HelpModal />;
    case 'add-project':
      return <AddProjectModal />;
    default:
      return null;
  }
});

const HelpModal = observer(HelpModalInner);
