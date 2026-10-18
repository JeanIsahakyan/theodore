import { useState } from 'react';
import { ArrowUpRightFromSquare, Xmark } from '@gravity-ui/icons';
import { Button, Card, Chip, Tabs, Tooltip } from '@heroui/react';
import { FEATURES } from '../features';

export interface SymbolPeekTarget {
  name: string;
  path: string;
  line: number;
}

/**
 * VS Code-style peek under the line: go-to-definition / find-references.
 * Ported from the prototype's mock-LSP version (`resolve()` over mock
 * symbol data), but there is no language server integration in the real
 * app — see `FEATURES.symbolPeek` ("No go-to-definition / find-references
 * command (LSP was mock-only)"). The chrome (header, tabs) stays so the
 * trigger — ⌘/Ctrl-click an identifier in `DiffPane` — still does
 * something; the body renders a disabled placeholder instead of inventing
 * a definition or reference list. Flip the flag once a real
 * `textDocument/definition`-style command exists, and wire the tabs below
 * to its response.
 */
export function SymbolPeek({
  target,
  onClose,
}: {
  target: SymbolPeekTarget;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<'def' | 'refs'>('def');
  return (
    <Card className="sym-peek max-w-[760px] gap-0 overflow-hidden p-0">
      <div className="flex items-center gap-2 border-b border-separator px-3 py-2">
        <Chip size="sm" variant="soft" color="accent">
          symbol
        </Chip>
        <code className="min-w-0 flex-1 truncate font-mono text-xs">
          {target.name}
        </code>
        <Tooltip>
          <Chip size="sm" variant="secondary" className="shrink-0">
            no LSP
          </Chip>
          <Tooltip.Content>Not available yet</Tooltip.Content>
        </Tooltip>
        <Button
          isIconOnly
          size="sm"
          variant="ghost"
          aria-label="Close"
          className="size-6 min-w-6"
          onPress={onClose}
        >
          <Xmark className="size-3.5" />
        </Button>
      </div>
      <Tabs
        data-plain
        selectedKey={tab}
        onSelectionChange={(k) => setTab(k as typeof tab)}
        className="px-3 pt-2"
      >
        <Tabs.ListContainer>
          <Tabs.List aria-label="Symbol" className="w-fit">
            <Tabs.Tab id="def" className="h-7 px-3 text-xs">
              Definition
              <Tabs.Indicator />
            </Tabs.Tab>
            <Tabs.Tab id="refs" className="sym-refs h-7 px-3 text-xs">
              <Tabs.Separator />
              References
              <Tabs.Indicator />
            </Tabs.Tab>
          </Tabs.List>
        </Tabs.ListContainer>
      </Tabs>
      <div className="flex items-center gap-2 px-3 py-4 text-xs text-muted">
        <ArrowUpRightFromSquare className="size-3.5 shrink-0" />
        {FEATURES.symbolPeek
          ? 'Resolving…'
          : `Go to ${tab === 'def' ? 'definition' : 'references'} is not available yet — no language server is wired up for this PR.`}
      </div>
    </Card>
  );
}
