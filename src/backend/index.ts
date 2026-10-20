import { createDemoBackend } from './demo';
import { createSupabaseBackend } from './supabase';
import type { Backend } from './types';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const isConfigured = Boolean(url && key);

function wantsDemo(): boolean {
  try {
    if (new URLSearchParams(window.location.search).has('demo')) localStorage.setItem('coloc-mode', 'demo');
    return localStorage.getItem('coloc-mode') === 'demo';
  } catch {
    return false;
  }
}

export const backend: Backend = isConfigured && !wantsDemo() ? createSupabaseBackend(url!, key!) : createDemoBackend();

export function leaveDemo() {
  try {
    localStorage.removeItem('coloc-mode');
  } catch {
    /* ignore */
  }
  window.location.href = window.location.pathname;
}

export function enterDemo() {
  try {
    localStorage.setItem('coloc-mode', 'demo');
  } catch {
    /* ignore */
  }
  window.location.href = window.location.pathname;
}

export * from './types';
