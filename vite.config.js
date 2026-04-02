import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    headers: {
      // Enables SharedArrayBuffer for optional future multi-thread core-mt
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
