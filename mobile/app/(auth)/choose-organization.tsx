/**
 * The organization picker for a sign-in that needs one (you're in several).
 * The pick is finished through the cloud; the pending sign-in is single-use,
 * so a failure goes back to "Sign in".
 *
 * ```text
 * Form (grouped list, like Settings)
 *   Organizations   one row per org ›  ─tap─▶ spinner + "Signing in…",
 *                   the others dimmed     the gate moves on when signed in
 *   footer          what this is for, or the error
 * no pending sign-in (expired, or it failed):
 *   footer "This sign-in has expired…" / the error, "Sign in again" row
 * ```
 */
import { router, type Href } from 'expo-router';
import { useState } from 'react';
import { useServices } from '../../src/services';
import { useAuthState } from '../../src/shell/AppProviders';
import { Button, Form, Row, Section } from '../../src/ui/native';

const LEAD =
  'Your account is in several organizations. Pick the one to use on this device; you can switch later in Settings.';

export default function ChooseOrganization() {
  const { auth } = useServices();
  const { choices, setChoices } = useAuthState();
  const [picking, setPicking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const backToSignIn = () => {
    setChoices(null);
    if (router.canGoBack()) router.back();
    else router.replace('/sign-in' as Href);
  };

  const pick = (id: string) => {
    if (picking) return;
    setPicking(id);
    setError(null);
    auth
      .chooseOrganization(id)
      .then((r) => {
        if (r.kind === 'failed') {
          setError(r.message);
          setChoices(null);
        }
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setChoices(null);
      })
      .finally(() => setPicking(null));
  };

  const list = choices ?? [];

  return (
    <Form testID="choose-organization">
      {list.length > 0 ? (
        <Section title="Organizations" footer={error ?? LEAD}>
          {list.map((o) => (
            <Row
              key={o.id}
              label={o.name || 'Unnamed organization'}
              detail={picking === o.id ? 'Signing in…' : undefined}
              chevron
              loading={picking === o.id}
              disabled={!!picking && picking !== o.id}
              accessibilityLabel={`Use ${o.name || o.id}`}
              onPress={() => pick(o.id)}
            />
          ))}
        </Section>
      ) : (
        <Section footer={error ?? 'This sign-in has expired. Sign in again.'}>
          <Button
            variant="primary"
            label="Sign in again"
            onPress={backToSignIn}
          />
        </Section>
      )}
    </Form>
  );
}
