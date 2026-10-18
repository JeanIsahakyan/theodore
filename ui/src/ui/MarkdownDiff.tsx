/** Rendered ("rich") view of a markdown file's change: blocks added since
 *  the base are green, removed ones red and struck through. */
import { observer } from 'mobx-react-lite';
import type { PrId } from '../gen/contract';
import { api } from '../core/api';
import { Md } from '../highlight';
import { useRootStore } from '../stores/context';
import { DiffSkeleton } from './Loading';
import { mdDiff } from './mdDiff';

export const MarkdownDiff = observer(function MarkdownDiff({
  pr,
  base,
  head,
  path,
  oldPath,
}: {
  pr: PrId;
  base: string;
  head: string;
  path: string;
  oldPath?: string | null;
}) {
  const store = useRootStore();
  const before = store.files.get(`${pr}@${base}:${oldPath ?? path}`, () =>
    api.getFile({ pr, rev: base, path: oldPath ?? path }),
  );
  const after = store.files.get(`${pr}@${head}:${path}`, () =>
    api.getFile({ pr, rev: head, path }),
  );
  if (before.status === 'loading' || after.status === 'loading')
    return <DiffSkeleton files={1} />;
  if (before.status === 'error' || after.status === 'error')
    return (
      <div className="px-4 py-3 text-sm text-danger">
        Couldn’t load the file: {before.error ?? after.error}
      </div>
    );
  const blocks = mdDiff(before.data ?? '', after.data ?? '');
  return (
    <div className="md-diff flex flex-col gap-1 px-5 py-4">
      {blocks.map((b, i) => (
        <div key={i} className={`md-block md-${b.kind}`}>
          <Md text={b.text} />
        </div>
      ))}
    </div>
  );
});
