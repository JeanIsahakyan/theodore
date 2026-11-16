/**
 * The organizations of the signed-in account, from the cloud (empty
 * until they arrive, or when the cloud can't say). The session itself is
 * `useAuthState()`: it follows sign-in, refresh and an org switch.
 */
import { useEffect, useState } from 'react';
import type { Organization } from '../../auth/types';
import { useServices } from '../../services';
import { useAuthState } from '../../shell/AppProviders';

export function useOrganizations(): Organization[] {
  const { auth } = useServices();
  const { session } = useAuthState();
  const user = session?.userId ?? null;
  const [found, setFound] = useState<{
    user: string;
    orgs: Organization[];
  } | null>(null);
  useEffect(() => {
    let live = true;
    if (!user) return undefined;
    auth
      .organizations()
      .then((orgs) => {
        if (live) setFound({ user, orgs });
      })
      .catch(() => {
        // the rows show what the session knows
      });
    return () => {
      live = false;
    };
  }, [auth, user]);
  return found && found.user === user ? found.orgs : [];
}
