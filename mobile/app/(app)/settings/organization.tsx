/**
 * Settings → Organization: the organizations you are in, a check on the
 * current one; tap another to switch (each row reads "Switch to <name>").
 *
 * ```text
 * ▦ Acme           Admin   ✓
 * ▦ Personal               ◌   (switching: a spinner, the others wait)
 * Spaces and devices belong to the organization you are in.
 *   | Couldn't switch organization. <why>   (never signs you out)
 * ```
 */
import { useState } from 'react';
import {
  SectionNote,
  SettingsRow,
  SettingsScroll,
  useOrganizations,
} from '../../../src/components/settings';
import { useServices } from '../../../src/services';
import { useAuthState } from '../../../src/shell/AppProviders';
import { setSwitching as setSwitchingTo } from '../../../src/state/accounts';
import { log, track } from '../../../src/telemetry/log';
import { errorText, roleLabel, switchErrorText } from '../../../src/ui/logic';
import { organizationNote } from '../../../src/ui/settingsView';

export default function OrganizationScreen() {
  const { auth } = useServices();
  const { session } = useAuthState();
  const orgs = useOrganizations();
  const [switching, setSwitching] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = orgs.find((o) => o.id === session?.organizationId);
  const role = current?.role ?? session?.role ?? null;

  const switchTo = (id: string) => {
    if (switching || id === session?.organizationId) return;
    setSwitching(id);
    setError(null);
    // Home says where it is going while the fleet reconnects.
    setSwitchingTo(orgs.find((o) => o.id === id)?.name || null);
    auth
      .switchOrganization(id)
      .catch((e: unknown) => {
        setSwitchingTo(null);
        track('org_switched', { ok: false });
        log.warn('organization switch failed', {
          'error.code': 'account.switch_failed',
          error: e instanceof Error ? e.message : String(e),
        });
        setError(switchErrorText(errorText(e)));
      })
      .finally(() => setSwitching(null));
  };

  const note = organizationNote(error, orgs.length);

  return (
    <SettingsScroll testID="settings-organizations">
      <SectionNote>
        {orgs.length > 1
          ? 'Choose the organization to work in on this device.'
          : 'The organization you work in on this device.'}
      </SectionNote>
      {orgs.length > 1 ? (
        orgs.map((o) => {
          const here = o.id === session?.organizationId;
          return (
            <SettingsRow
              key={o.id}
              icon="organization"
              label={o.name}
              subtitle={here && role ? roleLabel(role) : undefined}
              selected={here}
              loading={switching === o.id}
              disabled={switching !== null && switching !== o.id}
              accessibilityLabel={`Switch to ${o.name}`}
              onPress={() => switchTo(o.id)}
            />
          );
        })
      ) : (
        <SettingsRow
          icon="organization"
          label={
            current?.name ?? (session?.organizationId ? 'Organization' : '—')
          }
          subtitle={role ? roleLabel(role) : undefined}
        />
      )}
      {note ? <SectionNote danger={!!error}>{note}</SectionNote> : null}
    </SettingsScroll>
  );
}
