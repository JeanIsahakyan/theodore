import { useState, type ReactNode } from 'react';
import { Button, Label, Modal, Radio, RadioGroup, Table, TextArea } from '@heroui/react';
import { observer } from 'mobx-react-lite';
import type { ReviewEvent } from '../gen/contract';
import { submitReview } from '../actions';
import { FEATURES } from '../features';
import { useRootStore, useUi } from '../stores/context';
import { AgentTag, K } from './bits';
import { CommandMenu, SnoozeMenu } from './Palette';

/** Shared modal frame — same shell every dialog in this file uses. */
function Shell({
  title,
  children,
  size = 'md',
  footer,
  onClose,
}: {
  title: string;
  children: ReactNode;
  size?: 'md' | 'lg';
  footer?: ReactNode;
  onClose: () => void;
}) {
  return (
    <Modal.Backdrop isOpen onOpenChange={(open) => !open && onClose()}>
      <Modal.Container
        size={size}
        placement="top"
        scroll="inside"
        className="mt-[8vh]"
      >
        <Modal.Dialog
          aria-label={title}
          className={`modal flex flex-col gap-3 p-4 ${size === 'lg' ? 'w-[760px] max-w-[92vw]' : 'w-[520px] max-w-[92vw]'}`}
        >
          <Modal.Heading>{title}</Modal.Heading>
          {children}
          {footer && <div className="flex justify-end gap-2">{footer}</div>}
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

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
  const drafts = store.models.drafts.where((d) => d.pr === pr);
  const reads = new Set(
    store.models.hunkReads.where((r) => r.pr === pr).map((r) => r.hunk),
  );
  const unread = store.models.groups
    .all()
    .filter((g) => g.kind !== 'hidden')
    .flatMap((g) => g.hunks)
    .filter((h) => !reads.has(h)).length;
  return (
    <Shell title={`Review · ${pr}`} size="lg" onClose={() => ui.closeModal()}>
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
                  <Table.Cell className="font-mono text-xs">
                    {d.anchor.path}:{d.anchor.line}
                  </Table.Cell>
                  <Table.Cell>
                    {d.source.kind === 'agent' ? (
                      <AgentTag id={d.source.agent} />
                    ) : (
                      <span className="text-xs text-muted">you</span>
                    )}
                  </Table.Cell>
                  <Table.Cell className="text-xs">
                    {d.body.slice(0, 110)}
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
          variant={event === 'REQUEST_CHANGES' ? 'danger' : 'primary'}
          isDisabled={sending}
          onPress={() => {
            setSending(true);
            void submitReview(store, pr, event, body.trim())
              .catch(() => {
                // toasted by api.ts
              })
              .finally(() => setSending(false));
            ui.closeModal();
            ui.goBack();
          }}
        >
          {sending ? 'Sending…' : 'Submit'}
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

function HelpModal() {
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

export const Modals = observer(function Modals() {
  const ui = useUi();
  switch (ui.modal) {
    case 'cmdk':
      return <CommandMenu />;
    case 'snooze':
      return <SnoozeMenu />;
    case 'submit':
      return <SubmitReviewModal />;
    case 'help':
      return <HelpModal />;
    default:
      return null;
  }
});
