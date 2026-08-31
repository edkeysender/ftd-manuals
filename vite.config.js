import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:5179',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
