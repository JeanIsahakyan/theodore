/**
 * Per-channel settings, baked at build time (EAS / `expo export` env):
 * `EXPO_PUBLIC_WORKOS_CLIENT_ID`, `EXPO_PUBLIC_CLOUD_URL`. Development
 * defaults point at staging (docs/cloud.md "Environments").
 */
export const config = {
  workosClientId:
    process.env.EXPO_PUBLIC_WORKOS_CLIENT_ID ??
    'client_01M5RM1W36AHHEGBE37QD3PS6K',
  workosApiBase: 'https://api.workos.com',
  cloudUrl:
    process.env.EXPO_PUBLIC_CLOUD_URL ?? 'https://api-staging.theodore.cloud',
  /** The privacy policy on the website (site/src/pages/Privacy.tsx, docs/website.md). */
  privacyPolicyUrl: 'https://theodore.cloud/privacy',
};
