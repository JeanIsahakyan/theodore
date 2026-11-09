import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
  },
  // 1420 matches devUrl in tauri.conf.json. A Theodore space gets its own port
  // and overrides devUrl to match (.theodore/config.yaml), so spaces don't collide.
  server: {
    port: Number(process.env.THEODORE_PORT) || 1420,
    strictPort: true,
  },
  test: {
    environment: 'jsdom',
    globals: false,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['./src/test/mobxSetup.ts'],
  },
});
