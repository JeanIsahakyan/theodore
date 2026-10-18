/** The Checks and Commits tabs of a PR — `PrDetail.checks` / `.commits`. */
import { Accordion, Chip, Table, Toolbar, Tooltip } from '@heroui/react';
import { observer } from 'mobx-react-lite';
import type {
  Check,
  CheckStatus,
  Commit,
  PrId,
  Reviewer,
} from '../gen/contract';
import { ask } from '../actions';
import { useRootStore } from '../stores/context';
import { ago } from './List';
import { Avatar, Btn } from './bits';

const ORDER: Record<CheckStatus, number> = {
  fail: 0,
  pending: 1,
  skipped: 2,
  pass: 3,
};

const STATUS_COLOR: Record<
  CheckStatus,
  'danger' | 'warning' | 'default' | 'success'
> = {
  fail: 'danger',
  pending: 'warning',
  skipped: 'default',
  pass: 'success',
};

const STATUS_LABEL: Record<CheckStatus, string> = {
  fail: 'failed',
  pending: 'running…',
  skipped: 'skipped',
  pass: 'passed',
};

function duration(ms: number | null): string {
  if (ms == null) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.round(s / 60)}m ${s % 60}s`;
}

export const Checks = observer(function Checks({
  pr,
  checks,
}: {
  pr: PrId;
  checks: Check[];
}) {
  const store = useRootStore();
  const sorted = [...checks].sort((a, b) => ORDER[a.status] - ORDER[b.status]);
  const failed = sorted.filter((c) => c.status === 'fail').map((c) => c.id);
  return (
    <main className="diff min-w-0 overflow-auto bg-background px-6 pb-20 pt-5">
      <div className="checks flex max-w-[900px] flex-col gap-2">
        <h3 className="text-sm font-semibold">Checks</h3>
        {sorted.length === 0 ? (
          <p className="text-sm text-muted">No checks reported.</p>
        ) : (
          <Accordion
            variant="surface"
            allowsMultipleExpanded
            defaultExpandedKeys={failed}
          >
            {sorted.map((c) => (
              <Accordion.Item key={c.id} id={c.id} className="check">
                <Accordion.Heading>
                  <Accordion.Trigger className="flex w-full items-center gap-3 px-4 py-3 text-left">
                    <Chip
                      size="sm"
                      variant="soft"
                      color={STATUS_COLOR[c.status]}
                    >
                      {c.status}
                    </Chip>
                    <b>{c.name}</b>
                    <span className="text-muted">
                      {c.status === 'pending'
                        ? STATUS_LABEL.pending
                        : duration(c.duration_ms)}
                    </span>
                    <span className="flex-1" />
                    {c.url && (
                      <a
                        href={c.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-accent"
                        onClick={(e) => e.stopPropagation()}
                      >
                        details
                      </a>
                    )}
                  </Accordion.Trigger>
                </Accordion.Heading>
                <Accordion.Panel>
                  <Accordion.Body className="flex flex-col gap-2">
                    <Toolbar aria-label={c.name} className="flex gap-1.5">
                      {c.status === 'fail' && (
                        <Btn
                          tone="tertiary"
                          onPress={() =>
                            void ask(store, {
                              pr,
                              question: `why did ${c.name} fail?`,
                              about: null,
                              group: null,
                              agent: null,
                            })
                          }
                        >
                          Why did it fail
                        </Btn>
                      )}
                    </Toolbar>
                  </Accordion.Body>
                </Accordion.Panel>
              </Accordion.Item>
            ))}
          </Accordion>
        )}
      </div>
    </main>
  );
});

export function Commits({ commits }: { commits: Commit[] }) {
  return (
    <main className="diff min-w-0 overflow-auto bg-background px-6 pb-20 pt-5">
      <Table className="max-w-[900px]">
        <Table.ScrollContainer>
          <Table.Content aria-label="Commits">
            <Table.Header>
              <Table.Column>sha</Table.Column>
              <Table.Column isRowHeader>commit</Table.Column>
              <Table.Column>author</Table.Column>
              <Table.Column>when</Table.Column>
            </Table.Header>
            <Table.Body
              renderEmptyState={() => (
                <span className="px-4 py-3 text-sm text-muted">
                  No commits.
                </span>
              )}
            >
              {commits.map((c) => (
                <Table.Row key={c.sha} id={c.sha}>
                  <Table.Cell className="font-mono text-accent">
                    {c.sha.slice(0, 7)}
                  </Table.Cell>
                  <Table.Cell>{c.title}</Table.Cell>
                  <Table.Cell>
                    <span className="inline-flex items-center gap-1.5">
                      <Avatar person={c.author} size={16} />
                      {c.author.name ?? c.author.login}
                    </span>
                  </Table.Cell>
                  <Table.Cell className="text-muted">{ago(c.at)}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Content>
        </Table.ScrollContainer>
      </Table>
    </main>
  );
}

const REVIEW_LABEL: Record<Reviewer['state'], string> = {
  requested: 'not reviewed yet',
  approved: 'approved',
  changes_requested: 'requested changes',
  commented: 'commented',
};

const REVIEW_COLOR: Record<
  Reviewer['state'],
  'default' | 'success' | 'danger'
> = {
  requested: 'default',
  approved: 'success',
  changes_requested: 'danger',
  commented: 'default',
};

/** Who reviews, and where they stand — chips with a name and a state, not just a dot. */
export function ReviewerStrip({ reviewers }: { reviewers: Reviewer[] }) {
  if (!reviewers.length) return null;
  return (
    <div className="reviewer-strip flex min-w-0 items-center gap-1.5 overflow-hidden">
      {reviewers.map((r, i) => (
        <Tooltip key={r.team ?? r.person.login ?? i}>
          <Chip
            size="sm"
            variant="soft"
            color={REVIEW_COLOR[r.state]}
            className="person shrink-0 gap-1.5 ps-0.5"
          >
            <Avatar person={r.person} size={18} />
            <span className="font-medium">
              {r.team ? `team:${r.team}` : r.person.login}
            </span>
          </Chip>
          <Tooltip.Content>{REVIEW_LABEL[r.state]}</Tooltip.Content>
        </Tooltip>
      ))}
    </div>
  );
}
