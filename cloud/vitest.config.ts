import { defineConfig } from 'vitest/config';

// The Worker uses only web APIs (fetch, Request, crypto.subtle), all in
// Node 22, so tests run the handler directly with a fake WorkOS. The OAuth
// provider imports `cloudflare:workers`: it is inlined so the alias to a
// stub applies.
export default defineConfig({
  resolve: {
    alias: {
      'cloudflare:workers': new URL(
        './test/stubs/cloudflare-workers.ts',
        import.meta.url,
      ).pathname,
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    server: { deps: { inline: ['@cloudflare/workers-oauth-provider'] } },
  },
});
