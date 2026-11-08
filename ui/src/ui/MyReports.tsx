/** Settings → About & updates → My reports: the issues "Report a problem"
 *  opened from this install, as the core last saw them on GitHub (it
 *  checks every 30 minutes). Hidden until there is one. */
import { Card, Chip, Typography } from '@heroui/react';
import { observer } from 'mobx-react-lite';
import type { TrackedReport } from '../gen/contract';
import { openExternal } from '../core/openExternal';
import { useRootStore } from '../stores/context';
import { ago } from './List';

type ChipColor = 'default' | 'accent' | 'success' | 'warning' | 'danger';

/** The status chip: its words and colour. */
export function reportStatus(r: TrackedReport): {
  label: string;
  color: ChipColor;
} {
  switch (r.status) {
    case 'open':
      return { label: 'Open', color: 'default' };
    case 'fixed':
      return {
        label: r.fixed_by ? `Fixed in #${r.fixed_by}` : 'Fixed',
        color: 'accent',
      };
    case 'released':
      return {
        label: r.released_in ? `Released in ${r.released_in}` : 'Released',
        color: 'success',
      };
    case 'not_planned':
      return {
        label: r.close_reason === 'duplicate' ? 'Duplicate' : 'Not planned',
        color: 'warning',
      };
  }
}

/** Newest first. */
export function sortReports(reports: readonly TrackedReport[]) {
  return [...reports].sort((a, b) => b.filed_at - a.filed_at);
}

export const MyReports = observer(function MyReports() {
  const store = useRootStore();
  const reports = sortReports(store.models.reports.all());
  if (reports.length === 0) return null;
  return (
    <section className="my-reports flex flex-col gap-2">
      <Typography.Heading level={6}>My reports</Typography.Heading>
      <Card variant="secondary" className="flex flex-col gap-0 p-0">
        {reports.map((r) => {
          const s = reportStatus(r);
          return (
            <button
              key={`${r.repo}#${r.number}`}
              type="button"
              className="my-report flex items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-default/40"
              title={r.url}
              onClick={() => openExternal(r.url)}
            >
              <span className="shrink-0 font-mono text-xs text-muted">
                #{r.number}
              </span>
              <span className="min-w-0 flex-1 truncate">{r.title}</span>
              <span className="shrink-0 text-xs text-muted">
                {r.comments > 0 &&
                  `${r.comments} comment${r.comments === 1 ? '' : 's'} · `}
                {ago(r.updated_at)} ago
              </span>
              <Chip
                size="sm"
                variant="soft"
                color={s.color}
                className="shrink-0"
              >
                {s.label}
              </Chip>
            </button>
          );
        })}
      </Card>
    </section>
  );
});
