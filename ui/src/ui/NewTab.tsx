/** A blank tab: one big field to paste a PR link, and recent PRs below. */
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { Button, InputGroup, TextField } from '@heroui/react';
import { ArrowRight, Link } from '@gravity-ui/icons';
import type { Route } from '../stores/UiStore';
import { useRootStore, useUi } from '../stores/context';
import { openPr } from '../actions';
import { looksLikePrUrl } from '../core/prUrl';

export const NewTab = observer(function NewTab({ route }: { route: Route }) {
  const store = useRootStore();
  const ui = useUi();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const recent = store.models.prSummaries
    .all()
    .slice()
    .sort((a, b) => b.updated_at - a.updated_at)
    .slice(0, 6);

  const submit = (u = url.trim()) => {
    if (!u || busy) return;
    setBusy(true);
    void openPr(store, u, route).finally(() => setBusy(false));
  };

  return (
    <div className="flex flex-1 flex-col items-center overflow-y-auto px-6 pt-[18vh]">
      <div className="flex w-full max-w-xl flex-col gap-3">
        <h1 className="text-lg font-semibold">Open a pull request</h1>
        <TextField
          aria-label="Pull request link"
          value={url}
          onChange={(v) => {
            setUrl(v);
            // Pasting a full link opens it right away.
            if (looksLikePrUrl(v) && v.length - url.length > 10)
              submit(v.trim());
          }}
          autoFocus
        >
          <InputGroup fullWidth className="h-11 rounded-2xl">
            <InputGroup.Prefix>
              <Link className="size-4 text-muted" />
            </InputGroup.Prefix>
            <InputGroup.Input
              placeholder="Paste a pull request link"
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
            <InputGroup.Suffix>
              <Button
                isIconOnly
                size="sm"
                aria-label="Open"
                isPending={busy}
                isDisabled={!url.trim()}
                onPress={() => submit()}
              >
                <ArrowRight className="size-4" />
              </Button>
            </InputGroup.Suffix>
          </InputGroup>
        </TextField>
        <p className="text-xs text-muted">
          github.com/owner/repo/pull/123 ·
          gitlab.com/group/project/-/merge_requests/7 · owner/repo#123. You can
          also press ⌘V anywhere outside a text field.
        </p>
        {recent.length > 0 && (
          <div className="mt-6 flex flex-col gap-1">
            <span className="px-2 text-xs text-muted">Recent</span>
            {recent.map((p) => (
              <button
                key={p.pr.repo.owner + p.pr.repo.name + p.pr.number}
                type="button"
                className="flex items-center gap-3 rounded-xl px-2 py-2 text-left hover:bg-default"
                onClick={() => {
                  const pr = `${p.pr.repo.host}:${p.pr.repo.owner}/${p.pr.repo.name}#${p.pr.number}`;
                  ui.replaceTab(route, { name: 'review', pr });
                }}
              >
                <span className="shrink-0 text-xs text-muted">
                  {p.pr.repo.name} #{p.pr.number}
                </span>
                <span className="truncate">{p.title}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
});
