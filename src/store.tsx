import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { backend, ConflictError, type AuthUser, type RealtimeStatus } from './backend';
import type { Category, HouseData, Profile, UUID, Zone } from './types';
import { errorMessage } from './lib/util';
import { today } from './lib/dates';
import { isOpen } from './lib/fairness';

// ---------------------------------------------------------------------
// Toasts (retour visuel après chaque action)
// ---------------------------------------------------------------------
export interface Toast {
  id: number;
  text: string;
  kind: 'success' | 'error' | 'info';
  action?: { label: string; run: () => void };
}

const ToastCtx = createContext<{ toasts: Toast[]; push: (t: Omit<Toast, 'id'>) => void; dismiss: (id: number) => void }>(null!);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback((t: Omit<Toast, 'id'>) => {
    const id = Date.now() + Math.random();
    setToasts((all) => [...all.slice(-3), { ...t, id }]);
    setTimeout(() => dismiss(id), t.kind === 'error' ? 7000 : 3500);
  }, [dismiss]);
  return <ToastCtx.Provider value={{ toasts, push, dismiss }}>{children}</ToastCtx.Provider>;
}
export const useToasts = () => useContext(ToastCtx);

// ---------------------------------------------------------------------
// Thème
// ---------------------------------------------------------------------
export function applyTheme(theme: 'system' | 'light' | 'dark' | undefined) {
  const t = theme ?? 'system';
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  try {
    localStorage.setItem('coloc-theme', t);
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------
// Store principal
// ---------------------------------------------------------------------
interface Store {
  user: AuthUser | null;
  authReady: boolean;
  recovery: boolean;
  setRecovery: (v: boolean) => void;
  householdId: string | null;
  setHouseholdId: (id: string | null) => void;
  data: HouseData | null;
  loading: boolean;
  loadError: string | null;
  online: boolean;
  realtime: RealtimeStatus;
  meId: UUID;
  me: Profile | undefined;
  otherId: UUID | null;
  memberIds: UUID[];
  name: (id: UUID | null | undefined) => string;
  personClass: (id: UUID | null | undefined) => string;
  zone: (id: UUID | null | undefined) => Zone | undefined;
  category: (id: UUID | null | undefined) => Category | undefined;
  reload: () => Promise<void>;
  /** Exécute une modification : vérifie la connexion, affiche le résultat, recharge les données concernées. */
  run: <T>(fn: () => Promise<T>, opts?: { success?: string; tables?: string[]; key?: string }) => Promise<T | undefined>;
  toast: (text: string, kind?: Toast['kind']) => void;
}

const StoreCtx = createContext<Store>(null!);
export const useStore = () => useContext(StoreCtx);

/** Pour les pages qui exigent les données chargées. */
export function useData() {
  const s = useStore();
  if (!s.data) throw new Error('Données non chargées');
  return { ...s, data: s.data };
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const { push } = useToasts();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [recovery, setRecovery] = useState(() => new URLSearchParams(window.location.search).has('reset'));
  const [householdId, setHouseholdId] = useState<string | null>(null);
  const [data, setData] = useState<HouseData | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [online, setOnline] = useState(() => navigator.onLine);
  const [realtime, setRealtime] = useState<RealtimeStatus>('connecting');
  const pending = useRef<Set<string>>(new Set());
  const timer = useRef<number | undefined>(undefined);

  const toast = useCallback((text: string, kind: Toast['kind'] = 'success') => push({ text, kind }), [push]);

  // Authentification
  useEffect(() => {
    let alive = true;
    backend.getUser().then((u) => {
      if (!alive) return;
      setUser(u);
      setAuthReady(true);
    }).catch(() => setAuthReady(true));
    const off = backend.onAuthChange((u, event) => {
      setUser(u);
      setAuthReady(true);
      if (event === 'PASSWORD_RECOVERY') setRecovery(true);
      if (event === 'SIGNED_OUT') {
        setHouseholdId(null);
        setData(null);
      }
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  // Nettoie l'URL après un retour d'e-mail (?code=…)
  useEffect(() => {
    if (authReady && /[?&]code=/.test(window.location.search)) {
      const keepReset = new URLSearchParams(window.location.search).has('reset');
      window.history.replaceState(null, '', window.location.pathname + (keepReset ? '?reset=1' : '') + window.location.hash);
    }
  }, [authReady, user]);

  // Colocation de la personne connectée
  useEffect(() => {
    if (!user) return;
    setLoading(true);
    backend.myHouseholdId().then((id) => {
      setHouseholdId(id);
      if (!id) setLoading(false);
    }).catch((e) => {
      setLoadError(errorMessage(e));
      setLoading(false);
    });
  }, [user]);

  const reload = useCallback(async () => {
    if (!householdId) return;
    setLoading(true);
    try {
      const d = await backend.loadAll(householdId);
      setData(d);
      setLoadError(null);
    } catch (e) {
      setLoadError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [householdId]);

  useEffect(() => {
    if (householdId) reload();
  }, [householdId, reload]);

  const refreshTables = useCallback((tables: string[]) => {
    if (!householdId) return;
    tables.forEach((t) => pending.current.add(t));
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(async () => {
      const list = [...pending.current];
      pending.current.clear();
      try {
        const results = await Promise.all(list.map((t) => backend.loadTable(householdId, t as never)));
        setData((d) => {
          if (!d) return d;
          const next = { ...d } as HouseData & Record<string, unknown>;
          list.forEach((t, i) => {
            if (t === 'households') next.household = (results[i] as HouseData['household'][])[0] ?? d.household;
            else if (t === 'household_members') next.members = results[i] as HouseData['members'];
            else next[t] = results[i];
          });
          return next;
        });
      } catch {
        /* rechargement complet à la reconnexion */
      }
    }, 150);
  }, [householdId]);

  // Synchronisation en temps réel
  useEffect(() => {
    if (!householdId || !user) return;
    const off = backend.subscribe(householdId, user.id, (t) => {
      refreshTables(t === 'expenses' ? ['expenses', 'expense_shares', 'activity_log'] : [t, 'activity_log']);
      if (t === 'household_members') refreshTables(['profiles']);
    }, setRealtime);
    return off;
  }, [householdId, user, refreshTables]);

  // Connexion réseau
  useEffect(() => {
    const on = () => {
      setOnline(true);
      reload();
      push({ text: 'Connexion rétablie : données actualisées.', kind: 'info' });
    };
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, [reload, push]);

  // Rafraîchir au retour sur l'onglet (mobile en arrière-plan)
  useEffect(() => {
    const vis = () => {
      if (document.visibilityState === 'visible' && householdId && navigator.onLine) reload();
    };
    document.addEventListener('visibilitychange', vis);
    return () => document.removeEventListener('visibilitychange', vis);
  }, [householdId, reload]);

  const inFlight = useRef<Set<string>>(new Set());
  const run = useCallback<Store['run']>(async (fn, opts) => {
    if (!navigator.onLine && backend.mode === 'supabase') {
      push({ text: 'Hors ligne : les modifications nécessitent une connexion.', kind: 'error' });
      return undefined;
    }
    const key = opts?.key;
    if (key && inFlight.current.has(key)) return undefined; // protège contre les doubles clics
    if (key) inFlight.current.add(key);
    try {
      const res = await fn();
      if (opts?.success) push({ text: opts.success, kind: 'success' });
      refreshTables([...(opts?.tables ?? []), 'notifications', 'activity_log']);
      return res;
    } catch (e) {
      if (e instanceof ConflictError) {
        push({ text: e.message, kind: 'error' });
        reload();
      } else {
        push({ text: errorMessage(e), kind: 'error' });
      }
      return undefined;
    } finally {
      if (key) inFlight.current.delete(key);
    }
  }, [push, refreshTables, reload]);

  const derived = useMemo(() => {
    const members = [...(data?.members ?? [])].sort((a, b) => a.joined_at.localeCompare(b.joined_at));
    const memberIds = members.map((m) => m.user_id);
    const meId = user?.id ?? '';
    const otherId = memberIds.find((m) => m !== meId) ?? null;
    const profiles = new Map((data?.profiles ?? []).map((p) => [p.id, p]));
    const zones = new Map((data?.zones ?? []).map((z) => [z.id, z]));
    const cats = new Map((data?.categories ?? []).map((c) => [c.id, c]));
    return {
      memberIds,
      meId,
      otherId,
      me: profiles.get(meId),
      name: (id: UUID | null | undefined) => (id ? (profiles.get(id)?.display_name || 'Ancien membre') : 'Non attribuée'),
      personClass: (id: UUID | null | undefined) => (!id ? 'p-none' : id === memberIds[0] ? 'p-a' : id === memberIds[1] ? 'p-b' : 'p-none'),
      zone: (id: UUID | null | undefined) => (id ? zones.get(id) : undefined),
      category: (id: UUID | null | undefined) => (id ? cats.get(id) : undefined),
    };
  }, [data, user]);

  // Thème personnel
  useEffect(() => {
    if (derived.me) applyTheme(derived.me.ui_prefs?.theme);
  }, [derived.me]);

  useBrowserNotifications(data, derived.me, derived.meId);

  const value: Store = {
    user, authReady, recovery, setRecovery, householdId, setHouseholdId, data, loading, loadError, online, realtime,
    ...derived, reload, run, toast,
  };
  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>;
}

// ---------------------------------------------------------------------
// Notifications du navigateur (quand l'application est ouverte ou en arrière-plan)
// ---------------------------------------------------------------------
function inQuietHours(start?: string, end?: string): boolean {
  if (!start || !end) return false;
  const n = new Date();
  const cur = n.getHours() * 60 + n.getMinutes();
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  const s = sh * 60 + sm, e = eh * 60 + em;
  return s <= e ? cur >= s && cur < e : cur >= s || cur < e;
}

async function showBrowserNotification(title: string, body: string) {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) await reg.showNotification(title, { body, icon: './icon-192.png', badge: './icon-192.png' });
    else new Notification(title, { body, icon: './icon-192.png' });
  } catch {
    /* non pris en charge */
  }
}

function useBrowserNotifications(data: HouseData | null, me: Profile | undefined, meId: string) {
  const seen = useRef<Set<string> | null>(null);
  const prefs = me?.notif_prefs;
  const allowed = () =>
    typeof Notification !== 'undefined' && Notification.permission === 'granted' && prefs?.browser && prefs.enabled !== false && !inQuietHours(prefs.quiet_start, prefs.quiet_end);

  // Nouvelles notifications reçues en direct
  useEffect(() => {
    if (!data) return;
    const ids = data.notifications.map((n) => n.id);
    if (seen.current === null) {
      seen.current = new Set(ids);
      return;
    }
    const fresh = data.notifications.filter((n) => !seen.current!.has(n.id) && !n.read_at);
    ids.forEach((id) => seen.current!.add(id));
    if (allowed()) fresh.slice(0, 3).forEach((n) => showBrowserNotification(n.title, n.body));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.notifications]);

  // Rappel local des tâches du jour, une fois par jour après l'heure choisie
  useEffect(() => {
    if (!data || !meId) return;
    const check = () => {
      const hour = prefs?.reminder_hour ?? '08:00';
      const [h, m] = hour.split(':').map(Number);
      const n = new Date();
      if (n.getHours() * 60 + n.getMinutes() < h * 60 + m) return;
      const key = `coloc-reminded-${meId}`;
      let last: string | null = null;
      try {
        last = localStorage.getItem(key);
      } catch {
        /* ignore */
      }
      if (last === today()) return;
      const mine = data.task_occurrences.filter((o) => o.assigned_to === meId && !o.proposed && isOpen(o) && o.due_date <= today());
      if (mine.length && allowed() && prefs?.categories?.task_due !== false) {
        const late = mine.filter((o) => o.due_date < today()).length;
        showBrowserNotification(`${mine.length} tâche(s) à faire`, late ? `Dont ${late} en retard` : mine.slice(0, 3).map((o) => o.name).join(', '));
      }
      try {
        localStorage.setItem(key, today());
      } catch {
        /* ignore */
      }
    };
    check();
    const t = window.setInterval(check, 10 * 60 * 1000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.task_occurrences, meId, prefs]);
}
