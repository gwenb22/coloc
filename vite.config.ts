import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base relatif : fonctionne sur https://<compte>.github.io/<depot>/ sans configuration
// Version affichée dans Paramètres (commit déployé + date), pour vérifier les mises à jour sur téléphone
const version = `${(process.env.GITHUB_SHA ?? 'local').slice(0, 7)} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;

export default defineConfig({
  base: './',
  define: { __APP_VERSION__: JSON.stringify(version) },
  plugins: [react()],
  test: { environment: 'node' },
});
