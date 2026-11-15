import { defineConfig } from 'vitest/config';

// Pure TypeScript only (src/fleet, src/keys logic, src/state): screens are
// exercised in the app, not here.
export default defineConfig({ test: { include: ['test/**/*.test.ts'] } });
