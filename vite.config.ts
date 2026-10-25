import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const API = `http://127.0.0.1:${process.env.PROPDESK_PORT ?? 4777}`;

export default defineConfig({
  root: r('./web'),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@shared': r('./shared'),
      '@': r('./web/src'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': API,
      '/ws': { target: API.replace('http', 'ws'), ws: true },
    },
  },
  build: {
    outDir: r('./web/dist'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
});
