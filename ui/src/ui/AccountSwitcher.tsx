/** The sidebar's bottom row and its popover (docs/cloud.md "Several
 *  accounts"): who is signed in and in which organization, every other
 *  account with its organizations (and "N running" when its spaces run),
 *  Add another account, Settings…, Sign out of the active one.
 *
 *  ```text
 *  │ (JI) Jean · Personal        ⌃   │   ← click: the popover above
 *  ┌──────────────────────────────────┐
 *  │ (JI) Jean                        │
 *  │   ✓ Personal                     │   ← click: switch (account, org)
 *  │     Acme Studio                  │
 *  │ (JA) jean@acme.com   · 2 running │
 *  │     Acme Inc                     │
 *  │ ──────────────────────────────── │
 *  │ + Add another account            │   ← the normal sign-in dialog
 *  │ Settings…                        │
 *  │ Sign out of Jean                 │   ← the active one only
 *  └──────────────────────────────────┘
 *  ```
 *
 *  Opening it lists every account's organizations again
 *  (`account_accounts`); until then the rows show the last list. Without a
 *  Theodore account (sandbox, fixtures, a dev build) the row shows the
 *  host login and the menu keeps only Settings and Report a problem. */
import {
  ArrowRightFromSquare,
  ChevronUp,
  CircleExclamation,
  Gear,
  Plus,
} from '@gravity-ui/icons';
import { Button, Dropdown, Header, Kbd, Label } from '@heroui/react';
import { observer } from 'mobx-react-lite';
import type { ReactNode } from 'react';
import type { AccountEntry } from '../gen/contract';
import { api } from '../core/api';
import {
  actionKey,
  activeAccount,
  listedOrganizations,
  orgLabel,
  parseActionKey,
  rowLabel,
  runningByAccount,
  runningLabel,
  shortName,
} from '../core/accounts';
import { accountLabel } from '../core/accountFlow';
import { useRootStore, useUi } from '../stores/context';
import { Avatar } from './bits';

function personOf(entry: AccountEntry) {
  return {
    login: entry.user.email,
    name: entry.user.name,
    avatar_url: entry.user.avatar_url,
  };
}

function Item({
  id,
  icon,
  label,
  keys,
  className,
  check = false,
}: {
  id: string;
  icon?: ReactNode;
  label: string;
  keys?: string;
  className?: string;
  check?: boolean;
}) {
  return (
    <Dropdown.Item
      id={id}
      textValue={label}
      className={`gap-2.5 ${className ?? ''}`}
    >
      {icon !== undefined && (
        <span className="grid size-4 shrink-0 place-items-center text-muted [&>svg]:size-4">
          {icon}
        </span>
      )}
      <Label className="min-w-0 flex-1 truncate" title={label}>
        {label}
      </Label>
      {keys && <Kbd className="ms-auto">{keys}</Kbd>}
      {check && <Dropdown.ItemIndicator />}
    </Dropdown.Item>
  );
}

/** One account in the popover: its header row, then its organizations
 *  (the current one checked), or "Sign in again" when its session ended. */
function AccountSection({
  entry,
  running,
}: {
  entry: AccountEntry;
  running: number | undefined;
}) {
  const runningText = entry.active ? null : runningLabel(running);
  return (
    <Dropdown.Section
      id={`account:${entry.user.id}`}
      className="account-section"
      aria-label={accountLabel(entry.user)}
    >
      <Header className="account-header flex items-center gap-2 px-2 pb-0.5 pt-1.5 text-xs">
        <Avatar person={personOf(entry)} size={18} />
        <span
          className="min-w-0 truncate font-medium text-foreground"
          title={entry.user.email}
        >
          {accountLabel(entry.user)}
        </span>
        {runningText && (
          <span className="account-running ms-auto shrink-0 text-muted">
            · {runningText}
          </span>
        )}
      </Header>
      {entry.sign_in_required ? (
        <Item
          id={actionKey({ kind: 'sign-in-again', userId: entry.user.id })}
          icon={<span />}
          label="Sign in again"
          className="account-sign-in-again"
        />
      ) : (
        listedOrganizations(entry).map((o) => (
          <Item
            key={o.id}
            id={actionKey({
              kind: 'switch',
              userId: entry.user.id,
              organizationId: o.id,
            })}
            icon={<span />}
            label={orgLabel(o)}
            className="account-org"
            check
          />
        ))
      )}
      {!entry.sign_in_required && !listedOrganizations(entry).length && (
        <Item
          id={actionKey({
            kind: 'switch',
            userId: entry.user.id,
            organizationId: null,
          })}
          icon={<span />}
          label="Switch to this account"
          className="account-org"
          check
        />
      )}
    </Dropdown.Section>
  );
}

export const AccountSwitcher = observer(function AccountSwitcher() {
  const store = useRootStore();
  const ui = useUi();
  const status = store.ephemeral.account;
  const viewer = store.ephemeral.viewer;
  const accounts = status?.accounts ?? [];
  const active = activeAccount(status);
  const running = runningByAccount(store.models.spaces.all());

  // Who the row names: the active Theodore account; the host login only
  // stands in when the build has no Theodore account.
  const me = active
    ? {
        person: personOf(active),
        label: rowLabel(active),
        title: active.user.email,
      }
    : status?.user
      ? {
          person: {
            login: status.user.email,
            name: status.user.name,
            avatar_url: status.user.avatar_url,
          },
          label: accountLabel(status.user),
          title: status.user.email,
        }
      : viewer
        ? {
            person: viewer,
            label: viewer.login,
            title: viewer.name ?? viewer.login,
          }
        : null;

  const selected = active
    ? new Set([
        actionKey({
          kind: 'switch',
          userId: active.user.id,
          organizationId: active.organization?.id ?? null,
        }),
      ])
    : new Set<string>();

  const act = (key: string) => {
    const a = parseActionKey(key);
    if (!a) return;
    switch (a.kind) {
      case 'settings':
        ui.go({ name: 'settings', page: 'account' });
        return;
      case 'report':
        ui.openModal('report-problem');
        return;
      case 'add':
        ui.openModal('sign-in');
        return;
      case 'sign-in-again': {
        const email = accounts.find((e) => e.user.id === a.userId)?.user.email;
        ui.openModal('sign-in', email ? [email] : []);
        return;
      }
      case 'sign-out':
        if (!active) return;
        void api
          .accountSignOutOf(active.user.id)
          .then((s) => store.ephemeral.setAccount(s))
          .catch(() => {});
        return;
      case 'switch':
        if (
          active &&
          a.userId === active.user.id &&
          (a.organizationId == null ||
            a.organizationId === (active.organization?.id ?? null))
        )
          return;
        void api
          .accountSwitch({
            user_id: a.userId,
            organization_id: a.organizationId,
          })
          .then((s) => store.ephemeral.setAccount(s))
          .catch(() => {});
        return;
    }
  };

  return (
    <Dropdown
      onOpenChange={(open) => {
        if (open && status?.available && accounts.length)
          void api
            .accountAccounts()
            .then((s) => store.ephemeral.setAccount(s))
            .catch(() => {});
      }}
    >
      <Button
        variant="ghost"
        size="sm"
        aria-label="Account and app"
        className="account-menu -ms-2 h-9 min-w-0 flex-1 justify-start gap-2 rounded-xl px-2"
      >
        {me ? (
          <>
            <Avatar person={me.person} size={24} />
            <span className="min-w-0 truncate text-sm" title={me.title}>
              {me.label}
            </span>
          </>
        ) : (
          <span className="min-w-0 truncate text-sm text-muted">
            Not signed in
          </span>
        )}
        <ChevronUp className="size-3 shrink-0 text-muted" />
      </Button>
      <Dropdown.Popover placement="top start" className="min-w-72">
        <Dropdown.Menu
          aria-label="Account and app"
          selectionMode="single"
          selectedKeys={selected}
          onAction={(k) => act(String(k))}
        >
          {accounts.map((entry) => (
            <AccountSection
              key={entry.user.id}
              entry={entry}
              running={running.get(entry.user.id)}
            />
          ))}
          <Dropdown.Section
            id="actions"
            aria-label="Account and app"
            className={
              accounts.length ? 'mt-1 border-t border-separator pt-1' : ''
            }
          >
            {status?.available && (
              <Item
                id={actionKey({ kind: 'add' })}
                icon={<Plus />}
                label={accounts.length ? 'Add another account' : 'Sign in'}
                className="account-add"
              />
            )}
            <Item
              id={actionKey({ kind: 'settings' })}
              icon={<Gear />}
              label="Settings…"
              keys="G S"
            />
            <Item
              id={actionKey({ kind: 'report' })}
              icon={<CircleExclamation />}
              label="Report a problem…"
            />
            {active && (
              <Item
                id={actionKey({ kind: 'sign-out' })}
                icon={<ArrowRightFromSquare />}
                label={`Sign out of ${shortName(active.user)}`}
                className="account-sign-out text-danger"
              />
            )}
          </Dropdown.Section>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
});
