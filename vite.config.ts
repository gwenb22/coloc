import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base relatif : fonctionne sur https://<compte>.github.io/<depot>/ sans configuration
export default defineConfig({
  base: './',
  plugins: [react()],
  test: { environment: 'node' },
});
