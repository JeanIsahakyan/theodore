import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const desktopUi = fileURLToPath(new URL('../ui/src', import.meta.url));

// The site shares the desktop's look: `@desktop/*` reaches the pure modules
// of ui/src (logo colours, tokens) without its stores or Tauri bindings.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@desktop': desktopUi },
  },
  server: {
    port: 4173,
    fs: { allow: ['.', desktopUi] },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
