import { defineConfig } from 'vitest/config';

// The Worker uses only web APIs (fetch, Request, crypto.subtle), all in
// Node 22, so tests run the handler directly with a fake WorkOS.
export default defineConfig({ test: { include: ['test/**/*.test.ts'] } });
