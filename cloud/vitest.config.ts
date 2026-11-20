import { defineConfig } from 'vitest/config';

// The Worker uses only web APIs (fetch, Request, crypto.subtle), all in
// Node 22, so tests run the handler directly with a fake WorkOS. The OAuth
// provider imports `cloudflare:workers`: it is inlined, and a plugin points
// that import at a stub. An alias isn't enough: Vite leaves a `scheme:`
// specifier to Node, which can't load it (a clean install shows it).
let root = '';

export default defineConfig({
  plugins: [
    {
      name: 'cloudflare-workers-stub',
      enforce: 'pre',
      configResolved: (c) => {
        root = c.root;
      },
      resolveId: (id) =>
        id === 'cloudflare:workers'
          ? `${root}/test/stubs/cloudflare-workers.ts`
          : null,
    },
  ],
  test: {
    include: ['test/**/*.test.ts'],
    server: { deps: { inline: ['@cloudflare/workers-oauth-provider'] } },
  },
});
