import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    // Preserve the browser host so Django's absolute pagination URLs stay on /api via Vite.
    proxy: { '/api': { target: 'http://localhost:8000', changeOrigin: false } },
  },
});
