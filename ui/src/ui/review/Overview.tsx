import { ArrowRight, BranchesRight, Tag } from '@gravity-ui/icons';
import { Chip, Typography } from '@heroui/react';
import type { PrDetail, PrId, PrSummary } from '../../gen/contract';
import { FEATURES } from '../../features';
import { Md } from '../../highlight';
import { Avatar } from '../bits';
import { LinearChips } from '../linear/LinearChips';
import { ago } from '../List';
import { PRIcon, prStatusLabel } from '../StatusIcon';

/** The PR at a glance: its number, full title, who opened it, which branch
 *  goes where, labels and the description — the header keeps only a
 *  one-line title. */
export function Overview({
  id,
  summary,
  detail,
  title,
  progress,
  branchReview,
}: {
  id: PrId;
  summary: PrSummary;
  detail: PrDetail | undefined;
  title: string;
  progress: number;
  branchReview: boolean;
}) {
  const { pr } = summary;
  const opened = summary.created_at ?? null;
  return (
    <main className="diff overview min-w-0 overflow-auto bg-surface px-8 pb-20 pt-6">
      <div className="flex max-w-[860px] flex-col gap-5">
        <div className="flex flex-col gap-1.5">
          <span className="text-sm text-muted">
            {pr.repo.owner}/{pr.repo.name}
            {!branchReview && <> · #{pr.number}</>}
          </span>
          <Typography.Heading level={3} className="text-balance">
            {title}
          </Typography.Heading>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
          <Chip size="sm" variant="secondary" className="gap-1.5">
            <PRIcon status={summary.state} progress={progress} />
            {prStatusLabel[summary.state]}
          </Chip>
          <span className="flex items-center gap-1.5">
            <Avatar person={summary.author} />
            {summary.author.login}
          </span>
          <span className="flex min-w-0 items-center gap-1.5 font-mono text-xs">
            <BranchesRight className="size-3.5 shrink-0 text-muted" />
            <span className="truncate rounded-md bg-default px-1.5 py-0.5">
              {summary.head_ref}
            </span>
            <ArrowRight className="size-3 shrink-0 text-muted" />
            <span className="truncate rounded-md bg-default px-1.5 py-0.5">
              {summary.base_ref}
            </span>
          </span>
          <span className="tabular-nums text-muted">
            {summary.changed_files}{' '}
            {summary.changed_files === 1 ? 'file' : 'files'}{' '}
            <span className="text-success">+{summary.additions}</span>{' '}
            <span className="text-danger">−{summary.deletions}</span>
          </span>
          {opened != null && (
            <span className="text-muted">opened {ago(opened)} ago</span>
          )}
        </div>

        {((detail?.labels.length ?? 0) > 0 || FEATURES.linear) && (
          <div className="flex flex-wrap items-center gap-2">
            {detail?.labels.map((l) => (
              <Chip
                key={l}
                size="sm"
                variant="soft"
                color="default"
                className="shrink-0 gap-1.5 ps-1.5"
              >
                <Tag className="size-3.5 text-muted" />
                <span className="font-medium">{l}</span>
              </Chip>
            ))}
            {FEATURES.linear && <LinearChips pr={id} />}
          </div>
        )}

        <section className="overview-body border-t border-separator pt-5">
          {detail?.body?.trim() ? (
            <div className="max-w-[78ch] text-sm">
              <Md text={detail.body} />
            </div>
          ) : (
            <span className="text-sm text-muted">
              {detail ? 'No description.' : 'Loading…'}
            </span>
          )}
        </section>
      </div>
    </main>
  );
}
