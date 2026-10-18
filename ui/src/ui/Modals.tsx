import { useState } from 'react';
import { Modal, Select, ListBox, TextArea } from '@heroui/react';
import { observer } from 'mobx-react-lite';
import type { ReviewEvent } from '../gen/contract';
import { submitReview } from '../actions';
import { useRootStore, useUi } from '../stores/context';
import { Btn, K } from './bits';
import { CommandMenu, SnoozeMenu } from './Palette';

const EVENTS: [ReviewEvent, string][] = [
  ['COMMENT', 'Comment'],
  ['APPROVE', 'Approve'],
  ['REQUEST_CHANGES', 'Request changes'],
];

const SubmitReviewModal = observer(function SubmitReviewModal() {
  const store = useRootStore();
  const ui = useUi();
  const [event, setEvent] = useState<ReviewEvent>('COMMENT');
  const [body, setBody] = useState('');
  if (ui.route.name !== 'review') return null;
  const pr = ui.route.pr;
  return (
    <Modal.Backdrop isOpen onOpenChange={(open) => !open && ui.closeModal()}>
      <Modal.Container size="md">
        <Modal.Dialog
          aria-label="Submit review"
          className="flex flex-col gap-3 p-4"
        >
          <Modal.Heading>Submit review</Modal.Heading>
          <Select
            aria-label="Review event"
            value={event}
            onChange={(v) => v && setEvent(v as ReviewEvent)}
          >
            <Select.Trigger>
              <Select.Value />
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox selectionMode="single">
                {EVENTS.map(([id, t]) => (
                  <ListBox.Item key={id} id={id} textValue={t}>
                    {t}
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ))}
              </ListBox>
            </Select.Popover>
          </Select>
          <TextArea
            fullWidth
            aria-label="Review summary"
            placeholder="Leave a comment (optional)"
            rows={4}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Btn tone="ghost" onPress={() => ui.closeModal()}>
              Cancel
            </Btn>
            <Btn
              tone="primary"
              onPress={() => {
                void submitReview(store, pr, event, body.trim()).catch(() => {
                  // toasted by api.ts
                });
                ui.closeModal();
                ui.goBack();
              }}
            >
              Submit
            </Btn>
          </div>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
});

const HelpModal = observer(function HelpModal() {
  const ui = useUi();
  return (
    <Modal.Backdrop isOpen onOpenChange={(open) => !open && ui.closeModal()}>
      <Modal.Container size="md">
        <Modal.Dialog
          aria-label="Keyboard shortcuts"
          className="flex flex-col gap-4 p-4"
        >
          <Modal.Heading>Keyboard shortcuts</Modal.Heading>
          <div className="flex flex-col gap-3 text-sm">
            <section className="flex flex-col gap-1">
              <div className="text-xs font-medium text-muted">Global</div>
              <div>
                <K>⌘K</K> command palette · <K>?</K> this help
              </div>
              <div>
                <K>G</K> <K>I</K> inbox · <K>G</K> <K>M</K> my PRs · <K>G</K>{' '}
                <K>T</K> tasks · <K>G</K> <K>S</K> settings
              </div>
              <div>
                <K>⌘Z</K> undo · <K>⌘⇧Z</K> redo
              </div>
              <div>
                <K>[</K> sidebar · <K>⌥1</K>–<K>⌥9</K> switch tab · <K>⌥W</K>{' '}
                close tab
              </div>
            </section>
            <section className="flex flex-col gap-1">
              <div className="text-xs font-medium text-muted">
                Lists (Inbox, My PRs, Tasks)
              </div>
              <div>
                <K>J</K>/<K>K</K> navigate · <K>⏎</K> open · <K>Space</K> peek
              </div>
              <div>
                <K>X</K> select · <K>E</K> done · <K>H</K> snooze · <K>Y</K>{' '}
                accept task fix
              </div>
            </section>
            <section className="flex flex-col gap-1">
              <div className="text-xs font-medium text-muted">Review</div>
              <div>
                <K>]</K> AI/tasks/threads panel · <K>S</K> split/unified ·{' '}
                <K>/</K> ask AI
              </div>
              <div>
                <K>T</K> tour · <K>R</K> (in tour) mark group read, next
              </div>
              <div>shift-click a second comment "+" for a line range</div>
            </section>
          </div>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
});

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
