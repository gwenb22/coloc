import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { HouseData } from '../types';
import { ConflictError, type AuthUser, type Backend, type DataTable, type RealtimeStatus } from './types';

const HOUSE_TABLES: DataTable[] = [
  'zones', 'categories', 'task_templates', 'task_occurrences', 'unavailabilities', 'swap_requests', 'comments',
  'expenses', 'expense_shares', 'recurring_expenses', 'reimbursements', 'budgets', 'shopping_items', 'stocks', 'maintenance',
];

/** Redirection après e-mail (confirmation, mot de passe oublié) : l'adresse actuelle de l'application. */
function appUrl(extra = '') {
  return window.location.origin + window.location.pathname + extra;
}

export function createSupabaseBackend(url: string, anonKey: string): Backend {
  const sb: SupabaseClient = createClient(url, anonKey, {
    auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });

  const toUser = (u: { id: string; email?: string } | null | undefined): AuthUser | null => (u ? { id: u.id, email: u.email ?? '' } : null);

  /** Récupère toutes les lignes (pagination au-delà de la limite de 1000 lignes de l'API). */
  async function fetchAll<T>(build: () => any, pageSize = 1000): Promise<T[]> {
    const out: T[] = [];
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await build().range(from, from + pageSize - 1);
      if (error) throw error;
      out.push(...(data as T[]));
      if (!data || data.length < pageSize) break;
    }
    return out;
  }

  async function loadTable(hid: string, table: string): Promise<unknown[]> {
    switch (table) {
      case 'households': {
        const { data, error } = await sb.from('households').select('*').eq('id', hid);
        if (error) throw error;
        return data;
      }
      case 'household_members':
        return fetchAll(() => sb.from('household_members').select('*').eq('household_id', hid));
      case 'profiles': {
        // RLS : uniquement soi-même et l'autre membre (actuel ou passé visible via l'historique)
        return fetchAll(() => sb.from('profiles').select('*'));
      }
      case 'notifications': {
        const { data, error } = await sb.from('notifications').select('*').eq('household_id', hid).order('created_at', { ascending: false }).limit(300);
        if (error) throw error;
        return data;
      }
      case 'activity_log': {
        const { data, error } = await sb.from('activity_log').select('*').eq('household_id', hid).order('created_at', { ascending: false }).limit(2000);
        if (error) throw error;
        return data;
      }
      case 'expense_shares':
        return fetchAll(() => sb.from('expense_shares').select('*').eq('household_id', hid).order('expense_id'));
      case 'recurring_expenses':
        // Table ajoutée par le correctif n°2 : si elle n'existe pas encore, l'application reste utilisable
        return fetchAll(() => sb.from(table).select('*').eq('household_id', hid).order('id')).catch(() => []);
      default:
        return fetchAll(() => sb.from(table).select('*').eq('household_id', hid).order('id'));
    }
  }

  return {
    mode: 'supabase',
    async getUser() {
      const { data } = await sb.auth.getSession();
      return toUser(data.session?.user);
    },
    onAuthChange(cb) {
      const { data } = sb.auth.onAuthStateChange((event, session) => cb(toUser(session?.user), event));
      return () => data.subscription.unsubscribe();
    },
    async signIn(email, password) {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
    },
    async signUp(email, password, displayName) {
      const { data, error } = await sb.auth.signUp({
        email, password, options: { data: { display_name: displayName }, emailRedirectTo: appUrl() },
      });
      if (error) throw error;
      return { needsConfirmation: !data.session };
    },
    async signOut() {
      await sb.auth.signOut();
    },
    async resetPassword(email) {
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: appUrl('?reset=1') });
      if (error) throw error;
    },
    async updatePassword(password) {
      const { error } = await sb.auth.updateUser({ password });
      if (error) throw error;
    },
    async myHouseholdId() {
      const { data: s } = await sb.auth.getSession();
      if (!s.session) return null;
      const { data, error } = await sb.from('household_members').select('household_id').eq('user_id', s.session.user.id).maybeSingle();
      if (error) throw error;
      return data?.household_id ?? null;
    },
    async loadAll(hid) {
      const tables = ['households', 'household_members', 'profiles', 'notifications', 'activity_log', ...HOUSE_TABLES];
      const results = await Promise.all(tables.map((t) => loadTable(hid, t)));
      const by = Object.fromEntries(tables.map((t, i) => [t, results[i]]));
      if (!by.households.length) throw new Error('Colocation introuvable.');
      return {
        ...(by as unknown as HouseData),
        household: by.households[0] as HouseData['household'],
        members: by.household_members as HouseData['members'],
      };
    },
    loadTable,
    async insert(table, rows) {
      const { data, error } = await sb.from(table).insert(rows as any).select();
      if (error) throw error;
      return data as any;
    },
    async update(table, id, patch, version) {
      let q = sb.from(table).update(patch as any).eq('id', id);
      if (version !== undefined) q = q.eq('version', version);
      const { data, error } = await q.select();
      if (error) throw error;
      if (!data || data.length === 0) throw new ConflictError();
      return data[0] as any;
    },
    async remove(table, id) {
      const { error } = await sb.from(table).delete().eq('id', id);
      if (error) throw error;
    },
    async rpc(name, args) {
      // Compatibilité avec une base sans le correctif n°2 : on n'envoie p_recurring_id que s'il est renseigné
      if (args && 'p_recurring_id' in args && args.p_recurring_id == null) {
        const { p_recurring_id: _omit, ...rest } = args;
        void _omit;
        args = rest;
      }
      const { data, error } = await sb.rpc(name, args ?? {});
      if (error) {
        if (error.code === 'P0002') throw new ConflictError();
        throw error;
      }
      return data as any;
    },
    subscribe(hid, userId, onChange, onStatus) {
      const ch = sb.channel(`house-${hid}`);
      for (const t of HOUSE_TABLES) {
        ch.on('postgres_changes', { event: '*', schema: 'public', table: t, filter: `household_id=eq.${hid}` }, () => onChange(t));
      }
      ch.on('postgres_changes', { event: '*', schema: 'public', table: 'households', filter: `id=eq.${hid}` }, () => onChange('households'));
      ch.on('postgres_changes', { event: '*', schema: 'public', table: 'household_members', filter: `household_id=eq.${hid}` }, () => onChange('household_members'));
      ch.on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, () => onChange('profiles'));
      ch.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${userId}` }, () => onChange('notifications'));
      ch.subscribe((status) => {
        const s: RealtimeStatus = status === 'SUBSCRIBED' ? 'live' : status === 'CLOSED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' ? 'offline' : 'connecting';
        onStatus(s);
      });
      return () => {
        sb.removeChannel(ch);
      };
    },
  };
}
