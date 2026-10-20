import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';

// Thème appliqué avant le premier rendu (évite le flash)
try {
  const t = localStorage.getItem('coloc-theme');
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
} catch {
  /* ignore */
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// PWA : mise en cache de l'interface uniquement (aucune donnée privée)
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => undefined);
  });
}
