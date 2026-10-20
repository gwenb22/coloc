import type { HouseData, TaskTemplate } from '../types';
import { uuid } from '../lib/util';
import { addDays, startOfWeek, today, toISO } from '../lib/dates';
import { computeShares } from '../lib/money';
import { coefs, occurrenceFields, planAssignments } from '../lib/fairness';
import { ConflictError, type AuthUser, type Backend } from './types';

/**
 * Mode démo : base de données locale (localStorage), deux personnes fictives.
 * Ouvrez deux onglets et choisissez une personne différente dans chacun pour voir la synchronisation.
 * Reproduit les principales règles du serveur (parts exactes, anti-doublons, échanges, notifications).
 */

const DB_KEY = 'coloc-demo-db-v1';
const USER_KEY = 'coloc-demo-user';
export const DEMO_USERS = [
  { id: 'd0000000-0000-4000-8000-00000000a1e5', email: 'alex@demo', name: 'Alex' },
  { id: 'd0000000-0000-4000-8000-0000000005a3', email: 'sam@demo', name: 'Sam' },
];

type Row = Record<string, any>;
type DB = Record<string, Row[]>;

const now = () => new Date().toISOString();
let db: DB = {};
let channel: BroadcastChannel | null = null;
const listeners = new Set<(table: string) => void>();
const authListeners = new Set<(u: AuthUser | null, e: string) => void>();

function load(): DB {
  try {
    const raw = localStorage.getItem(DB_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* stockage indisponible */
  }
  return seed();
}

function save(changed: string[]) {
  try {
    localStorage.setItem(DB_KEY, JSON.stringify(db));
  } catch {
    /* navigation privée : la démo reste en mémoire */
  }
  for (const t of changed) {
    channel?.postMessage(t);
    listeners.forEach((l) => l(t));
  }
}


function currentUser(): AuthUser | null {
  let id: string | null = null;
  try {
    // Raccourci démo : ?as=alex ou ?as=sam (captures d'écran, tests)
    const as = new URLSearchParams(window.location.search).get('as');
    const pick = DEMO_USERS.find((u) => u.name.toLowerCase() === as);
    if (pick) sessionStorage.setItem(USER_KEY, pick.id);
    id = sessionStorage.getItem(USER_KEY);
  } catch {
    /* ignore */
  }
  const u = DEMO_USERS.find((x) => x.id === id);
  return u ? { id: u.id, email: u.email } : null;
}
const uid = () => currentUser()?.id ?? null;
const hid = () => db.household_members.find((m) => m.user_id === uid())?.household_id ?? null;
const other = (h: string, me: string | null) => db.household_members.find((m) => m.household_id === h && m.user_id !== me)?.user_id ?? null;
const nameOf = (id: string | null) => db.profiles.find((p) => p.id === id)?.display_name ?? 'Colocataire';

function fail(msg: string): never {
  const e = new Error(msg) as Error & { code: string };
  e.code = 'P0001';
  throw e;
}

function notify(h: string, to: string | null, type: string, title: string, body = '', link = '') {
  if (!to) return;
  const prefs = db.profiles.find((p) => p.id === to)?.notif_prefs ?? {};
  if (prefs.enabled === false || prefs.categories?.[type] === false) return;
  db.notifications.unshift({ id: uuid(), household_id: h, user_id: to, type, title, body, link, read_at: null, created_at: now() });
}

function log(h: string, entity: string, entity_id: string | null, action: string, details: Row = {}) {
  db.activity_log.unshift({ id: Date.now() + Math.random(), household_id: h, user_id: uid(), entity, entity_id, action, details, created_at: now() });
}

const DEFAULTS: Record<string, () => Row> = {
  zones: () => ({ icon: '🏠', active: true, position: 0 }),
  categories: () => ({ position: 0, archived: false }),
  task_templates: () => ({ description: '', instructions: '', weekdays: [], once_date: null, window_days: 0, effort: 'moderate', preferred_user: null, fixed_user: null, start_date: today(), end_date: null, active: true, archived: false, created_by: uid() }),
  task_occurrences: () => ({ status: 'todo', proposed: false, locked: false, done_at: null, done_by: null, actual_min: null, problem: null }),
  unavailabilities: () => ({ note: '' }),
  swap_requests: () => ({ message: '', status: 'pending', responded_at: null }),
  comments: () => ({ user_id: uid() }),
  reimbursements: () => ({ note: '', status: 'done', created_by: uid() }),
  budgets: () => ({ month: 0, category_limits: {} }),
  shopping_items: () => ({ quantity: 1, unit: '', category: 'Autres', priority: 'normal', assigned_to: null, status: 'to_buy', note: '', price_estimate_cents: null, stock_id: null, bought_at: null, bought_by: null, created_by: uid() }),
  stocks: () => ({ quantity: 0, unit: '', min_threshold: 1, location: '', updated_at: now() }),
  maintenance: () => ({ description: '', category: 'Autre', reported_at: today(), priority: 'normal', owner: null, due_date: null, status: 'todo', created_by: uid() }),
};

function afterInsert(table: string, r: Row) {
  const me = uid();
  if (table === 'swap_requests') {
    const occ = db.task_occurrences.find((o) => o.id === r.occurrence_id);
    notify(r.household_id, r.to_user, 'swap', `Demande d'échange : ${occ?.name}`, r.message || `${nameOf(r.from_user)} vous propose de reprendre cette tâche`, '/notifications');
  }
  if (table === 'reimbursements') {
    notify(r.household_id, other(r.household_id, me), 'reimbursement', r.status === 'planned' ? 'Remboursement prévu' : 'Remboursement enregistré', `${nameOf(r.from_user)} → ${nameOf(r.to_user)} : ${(r.amount_cents / 100).toFixed(2)}`, '/budget');
    log(r.household_id, 'reimbursement', r.id, 'insert', r);
  }
  if (table === 'shopping_items') notify(r.household_id, other(r.household_id, me), 'shopping', `Courses : ${r.name}`, `${nameOf(me)} a ajouté un article`, '/courses');
  if (table === 'stocks' && Number(r.quantity) <= Number(r.min_threshold)) stockAlert(r);
  if (table === 'maintenance') log(r.household_id, 'maintenance', r.id, 'insert', r);
  if (table === 'task_templates') log(r.household_id, 'template', r.id, 'insert', r);
}

function stockAlert(r: Row) {
  for (const m of db.household_members.filter((m) => m.household_id === r.household_id)) {
    notify(r.household_id, m.user_id, 'stock', `Bientôt épuisé : ${r.name}`, `Quantité : ${r.quantity}`, '/courses');
  }
}

function afterUpdate(table: string, old: Row, r: Row) {
  const me = uid();
  if (table === 'task_occurrences') {
    if (old.assigned_to !== r.assigned_to) {
      log(r.household_id, 'occurrence', r.id, 'reassign', { from: old.assigned_to, to: r.assigned_to });
      if (!r.proposed && r.assigned_to !== me) notify(r.household_id, r.assigned_to, 'task_assigned', `Tâche attribuée : ${r.name}`, '', '/taches');
    }
    if (old.status !== r.status) log(r.household_id, 'occurrence', r.id, 'status', { from: old.status, to: r.status });
    if (old.due_date !== r.due_date) log(r.household_id, 'occurrence', r.id, 'postpone', { from: old.due_date, to: r.due_date });
  }
  if (table === 'reimbursements' && old.status !== r.status) {
    notify(r.household_id, other(r.household_id, me), 'reimbursement', r.status === 'done' ? 'Remboursement effectué' : 'Remboursement annulé', '', '/budget');
    log(r.household_id, 'reimbursement', r.id, 'update', r);
  }
  if (table === 'stocks' && Number(r.quantity) <= Number(r.min_threshold) && Number(old.quantity) > Number(old.min_threshold)) stockAlert(r);
  if (table === 'stocks') r.updated_at = now();
  if (table === 'maintenance') {
    log(r.household_id, 'maintenance', r.id, 'update', { before: old, after: r });
    if (r.owner && r.owner !== me && old.owner !== r.owner) notify(r.household_id, r.owner, 'maintenance', `Entretien à suivre : ${r.title}`, '', '/entretien');
  }
  if (table === 'task_templates') log(r.household_id, 'template', r.id, 'update', { before: old, after: r });
}

const rpcs: Record<string, (a: Row) => unknown> = {
  peek_invite: (a) => {
    const h = db.households.find((x) => x.invite_code && x.invite_code === String(a.p_code).trim().toUpperCase());
    if (!h) fail('Invitation introuvable ou expirée.');
    return { name: h.name, from: nameOf(h.created_by), full: db.household_members.filter((m) => m.household_id === h.id).length >= 2 };
  },
  join_household: () => fail('Non disponible en mode démo : les deux personnes sont déjà membres.'),
  create_household: () => fail('Non disponible en mode démo.'),
  regenerate_invite: () => fail('La colocation de démonstration est complète.'),
  transfer_owner: (a) => {
    const h = hid()!;
    for (const m of db.household_members.filter((m) => m.household_id === h)) m.role = m.user_id === a.p_user ? 'owner' : 'member';
    log(h, 'household', h, 'transfer_owner', { to: a.p_user });
    return null;
  },
  leave_household: () => fail('Non disponible en mode démo. Utilisez « Réinitialiser la démo ».'),
  delete_my_account: () => fail('Non disponible en mode démo.'),
  save_expense: (a) => {
    const h = hid();
    if (!h) fail('Aucune colocation.');
    const shares = a.p_shares as Row[];
    const total = shares.reduce((s, x) => s + Number(x.share_cents), 0);
    if (total !== a.p_amount_cents) fail(`La somme des parts (${total} c) doit être égale au montant (${a.p_amount_cents} c).`);
    if (a.p_split_mode === 'percent' && Math.abs(shares.reduce((s, x) => s + Number(x.percent ?? 0), 0) - 100) > 0.001) fail('Les pourcentages doivent totaliser 100 %.');
    const fields = {
      title: a.p_title, amount_cents: a.p_amount_cents, date: a.p_date, category_id: a.p_category_id, paid_by: a.p_paid_by,
      split_mode: a.p_split_mode, status: a.p_status ?? 'validated', note: a.p_note ?? '', maintenance_id: a.p_maintenance_id,
    };
    let e: Row | undefined;
    if (!a.p_id) {
      e = db.expenses.find((x) => x.client_key === a.p_client_key);
      if (e) return e.id;
      e = { id: uuid(), household_id: h, client_key: a.p_client_key, created_by: uid(), created_at: now(), version: 1, ...fields };
      db.expenses.push(e);
      log(h, 'expense', e.id, 'create', { title: e.title, amount_cents: e.amount_cents });
      if (e.status === 'validated') notify(h, other(h, uid()), 'expense', `Nouvelle dépense : ${e.title}`, `${nameOf(uid())} a ajouté ${(e.amount_cents / 100).toFixed(2)} €`, '/budget');
    } else {
      e = db.expenses.find((x) => x.id === a.p_id);
      if (!e || e.version !== a.p_version) throw new ConflictError();
      const before = { ...e };
      Object.assign(e, fields, { version: e.version + 1 });
      db.expense_shares = db.expense_shares.filter((s) => s.expense_id !== e!.id);
      log(h, 'expense', e.id, 'update', { before, after: { ...e } });
      notify(h, other(h, uid()), 'expense', `Dépense modifiée : ${e.title}`, 'Informations mises à jour', '/budget');
    }
    for (const s of shares) db.expense_shares.push({ expense_id: e.id, household_id: h, user_id: s.user_id, share_cents: s.share_cents, percent: s.percent ?? null });
    return e.id;
  },
  set_expense_status: (a) => {
    const e = db.expenses.find((x) => x.id === a.p_id);
    if (!e || e.version !== a.p_version) throw new ConflictError();
    const before = { ...e };
    e.status = a.p_status;
    e.version++;
    log(e.household_id, 'expense', e.id, 'update', { before, after: { ...e } });
    notify(e.household_id, other(e.household_id, uid()), 'expense', `Dépense modifiée : ${e.title}`, a.p_status === 'cancelled' ? 'Dépense annulée' : 'Dépense validée', '/budget');
    return null;
  },
  respond_swap: (a) => {
    const r = db.swap_requests.find((x) => x.id === a.p_id);
    if (!r) fail('Demande introuvable.');
    if (r.to_user !== uid()) fail('Seule la personne sollicitée peut répondre.');
    if (r.status !== 'pending') fail('Cette demande a déjà reçu une réponse.');
    r.status = a.p_accept ? 'accepted' : 'refused';
    r.responded_at = now();
    r.version++;
    const occ = db.task_occurrences.find((o) => o.id === r.occurrence_id)!;
    if (a.p_accept) {
      log(occ.household_id, 'occurrence', occ.id, 'reassign', { from: occ.assigned_to, to: r.to_user, swap: true });
      occ.assigned_to = r.to_user;
      occ.locked = true;
      occ.version++;
    }
    notify(r.household_id, r.from_user, 'swap', `Échange ${a.p_accept ? 'accepté' : 'refusé'} : ${occ.name}`, nameOf(r.to_user), '/taches');
    return null;
  },
};

export function createDemoBackend(): Backend {
  db = load();
  if (typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel('coloc-demo');
    channel.addEventListener('message', (e) => {
      db = load();
      listeners.forEach((l) => l(String(e.data)));
    });
  }
  return {
    mode: 'demo',
    async getUser() {
      return currentUser();
    },
    onAuthChange(cb) {
      authListeners.add(cb);
      return () => authListeners.delete(cb);
    },
    async signIn(email) {
      const u = DEMO_USERS.find((x) => x.email === email);
      if (!u) throw new Error('Choisissez Alex ou Sam.');
      sessionStorage.setItem(USER_KEY, u.id);
      authListeners.forEach((l) => l({ id: u.id, email: u.email }, 'SIGNED_IN'));
    },
    async signUp() {
      throw new Error('Inscription non disponible en mode démo.');
    },
    async signOut() {
      sessionStorage.removeItem(USER_KEY);
      authListeners.forEach((l) => l(null, 'SIGNED_OUT'));
    },
    async resetPassword() {
      throw new Error('Non disponible en mode démo.');
    },
    async updatePassword() {
      throw new Error('Non disponible en mode démo.');
    },
    async myHouseholdId() {
      return hid();
    },
    async loadAll(h) {
      const pick = (t: string) => structuredClone(db[t].filter((r) => r.household_id === h));
      const memberIds = db.household_members.filter((m) => m.household_id === h).map((m) => m.user_id);
      return {
        household: structuredClone(db.households.find((x) => x.id === h)),
        members: pick('household_members'),
        profiles: structuredClone(db.profiles.filter((p) => memberIds.includes(p.id))),
        zones: pick('zones'), categories: pick('categories'), task_templates: pick('task_templates'),
        task_occurrences: pick('task_occurrences'), unavailabilities: pick('unavailabilities'), swap_requests: pick('swap_requests'),
        comments: pick('comments'), expenses: pick('expenses'), expense_shares: pick('expense_shares'),
        reimbursements: pick('reimbursements'), budgets: pick('budgets'), shopping_items: pick('shopping_items'),
        stocks: pick('stocks'), maintenance: pick('maintenance'),
        notifications: structuredClone(db.notifications.filter((n) => n.household_id === h && n.user_id === uid())),
        activity_log: pick('activity_log'),
      } as HouseData;
    },
    async loadTable(h, table) {
      const all = await this.loadAll(h);
      if (table === 'households') return [all.household];
      if (table === 'household_members') return all.members;
      return (all as any)[table];
    },
    async insert(table, rows) {
      const list = (Array.isArray(rows) ? rows : [rows]) as Row[];
      const out: Row[] = [];
      for (const r of list) {
        const row: Row = { id: uuid(), created_at: now(), version: 1, ...(DEFAULTS[table]?.() ?? {}), ...r };
        if (table === 'task_occurrences' && db.task_occurrences.some((o) => o.template_id === row.template_id && o.scheduled_date === row.scheduled_date)) {
          fail('duplicate key : occurrence déjà planifiée');
        }
        if (table === 'reimbursements' && db.reimbursements.some((x) => x.client_key === row.client_key)) fail('duplicate key : remboursement déjà enregistré');
        if (table === 'swap_requests' && db.swap_requests.some((x) => x.occurrence_id === row.occurrence_id && x.status === 'pending')) fail('Une demande est déjà en attente pour cette tâche.');
        db[table].push(row);
        afterInsert(table, row);
        out.push(structuredClone(row));
      }
      save([table, 'notifications', 'activity_log']);
      return out as any;
    },
    async update(table, id, patch, version) {
      const list = db[table];
      const r = list.find((x) => x.id === id);
      if (!r || (version !== undefined && r.version !== version)) throw new ConflictError();
      const old = { ...r };
      Object.assign(r, patch);
      if ('version' in old) r.version = old.version + 1;
      afterUpdate(table, old, r);
      save([table, 'notifications', 'activity_log']);
      return structuredClone(r) as any;
    },
    async remove(table, id) {
      db[table] = db[table].filter((x) => x.id !== id);
      save([table]);
    },
    async rpc(name, args) {
      const fn = rpcs[name];
      if (!fn) fail(`Fonction inconnue : ${name}`);
      const res = fn(args ?? {});
      save(['expenses', 'expense_shares', 'swap_requests', 'task_occurrences', 'household_members', 'notifications', 'activity_log']);
      return res as any;
    },
    subscribe(_h, _u, onChange, onStatus) {
      listeners.add(onChange);
      onStatus('live');
      return () => listeners.delete(onChange);
    },
  };
}

export function resetDemo() {
  db = seed();
  save(['households']);
}

// ---------------------------------------------------------------------
// Données de démonstration
// ---------------------------------------------------------------------
function seed(): DB {
  const [A, B] = DEMO_USERS.map((u) => u.id);
  const h = uuid();
  const t = today();
  const d: DB = {
    households: [{
      id: h, name: 'Appart de la rue des Lilas', currency: 'EUR', start_date: addDays(t, -28), invite_code: null, created_by: A, created_at: now(), version: 1,
      settings: { effort_coef: { light: 1, moderate: 1.2, heavy: 1.5 }, default_split: 'equal', enable_in_progress: false, avoid_repeats: true, window_weeks: 4 },
    }],
    household_members: [
      { household_id: h, user_id: A, role: 'owner', joined_at: now() },
      { household_id: h, user_id: B, role: 'member', joined_at: now() },
    ],
    profiles: DEMO_USERS.map((u) => ({ id: u.id, display_name: u.name, notif_prefs: {}, ui_prefs: {}, deleted: false, version: 1, created_at: now() })),
    zones: [], categories: [], task_templates: [], task_occurrences: [], unavailabilities: [], swap_requests: [], comments: [],
    expenses: [], expense_shares: [], reimbursements: [], budgets: [], shopping_items: [], stocks: [], maintenance: [], notifications: [], activity_log: [],
  };
  const zones = [['Cuisine', '🍳'], ['Salle de bain', '🛁'], ['WC', '🚽'], ['Salon', '🛋️'], ['Entrée', '🚪'], ['Balcon / terrasse', '🌿']];
  zones.forEach(([name, icon], i) => d.zones.push({ id: uuid(), household_id: h, name, icon, active: true, position: i + 1, version: 1 }));
  const zid = (n: string) => d.zones.find((z) => z.name === n)!.id;
  ['Courses alimentaires', 'Produits ménagers', 'Loyer', 'Électricité et gaz', 'Eau', 'Internet', 'Assurance habitation', 'Mobilier et équipement', 'Réparations et entretien', 'Autres dépenses']
    .forEach((name, i) => d.categories.push({ id: uuid(), household_id: h, kind: 'expense', name, position: i + 1, archived: false, version: 1 }));
  ['Alimentation', 'Produits ménagers', 'Hygiène et salle de bain', 'Consommables', 'Équipement', 'Autres']
    .forEach((name, i) => d.categories.push({ id: uuid(), household_id: h, kind: 'shopping', name, position: i + 1, archived: false, version: 1 }));
  const cat = (n: string) => d.categories.find((c) => c.name === n && c.kind === 'expense')!.id;

  const tpls: [string, string, 'daily' | 'weekly', number[], number, 'light' | 'moderate' | 'heavy', string?][] = [
    ['Cuisine', 'Vaisselle et plans de travail', 'daily', [], 15, 'light', 'Éponge propre, liquide vaisselle. Essuyer et ranger.'],
    ['Cuisine', 'Sortir les poubelles', 'weekly', [1, 4], 5, 'light', 'Tri : jaune le lundi, verre le jeudi.'],
    ['Cuisine', 'Nettoyer les plaques', 'weekly', [3], 10, 'moderate'],
    ['Cuisine', 'Laver le sol de la cuisine', 'weekly', [6], 15, 'moderate'],
    ['Cuisine', 'Nettoyer le réfrigérateur', 'weekly', [7], 25, 'heavy', 'Jeter les produits périmés, vinaigre blanc.'],
    ['Salle de bain', 'Nettoyer la douche', 'weekly', [6], 20, 'heavy', 'Anticalcaire, rincer, raclette.'],
    ['Salle de bain', 'Lavabo et miroir', 'weekly', [3], 10, 'light'],
    ['Salle de bain', 'Sol de la salle de bain', 'weekly', [6], 10, 'moderate'],
    ['WC', 'Nettoyer la cuvette et désinfecter', 'weekly', [2, 6], 10, 'heavy', 'Gants, gel WC, désinfectant surfaces.'],
    ['Salon', 'Ranger et dépoussiérer', 'weekly', [5], 15, 'light'],
    ['Salon', 'Aspirer le salon', 'weekly', [6], 20, 'moderate'],
    ['Entrée', 'Ranger les chaussures et nettoyer le sol', 'weekly', [7], 10, 'light'],
    ['Balcon / terrasse', 'Balayer le balcon', 'weekly', [7], 15, 'moderate'],
  ];
  for (const [zone, name, frequency, weekdays, duration_min, effort, instructions] of tpls) {
    d.task_templates.push({
      id: uuid(), household_id: h, zone_id: zid(zone), name, description: '', instructions: instructions ?? '', frequency, weekdays, once_date: null,
      window_days: 0, duration_min, effort, preferred_user: null, fixed_user: null, start_date: addDays(t, -28), end_date: null,
      active: true, archived: false, created_by: A, created_at: now(), version: 1,
    });
  }

  // 4 semaines passées + semaine en cours, planifiées avec l'algorithme d'équité
  const c = coefs(d.households[0].settings);
  let ws = addDays(startOfWeek(t), -28);
  for (let w = 0; w < 5; w++, ws = addDays(ws, 7)) {
    const plan = planAssignments({
      members: [A, B], templates: d.task_templates as TaskTemplate[], occurrences: d.task_occurrences as any, unavailabilities: [],
      settings: d.households[0].settings, start: ws, end: addDays(ws, 6),
    });
    for (const s of plan.slots) {
      const tpl = d.task_templates.find((x) => x.id === s.template_id)! as TaskTemplate;
      const o: Row = { id: uuid(), created_at: now(), version: 1, done_at: null, done_by: null, actual_min: null, problem: null, ...occurrenceFields(tpl, s.scheduled_date, s.assigned_to, s.weight, false) };
      void c;
      if (o.due_date < t) {
        const r = (o.name.length * 7 + Number(o.due_date.slice(8))) % 10;
        if (r < 8 || o.due_date < addDays(t, -2)) {
          o.status = r === 9 && o.due_date < addDays(t, -7) ? 'cancelled' : 'done';
          if (o.status === 'done') {
            o.done_by = o.assigned_to;
            o.done_at = o.due_date + 'T19:00:00.000Z';
            o.actual_min = r % 3 === 0 ? o.estimated_min + 5 : null;
          }
        }
      }
      d.task_occurrences.push(o);
    }
  }

  // Dépenses
  const month = t.slice(0, 7);
  const addExp = (title: string, cents: number, date: string, category: string, paid_by: string, mode: 'equal' | 'percent' | 'single' = 'equal', pct?: number[]) => {
    const id = uuid();
    d.expenses.push({ id, household_id: h, client_key: uuid(), title, amount_cents: cents, date, category_id: cat(category), paid_by, split_mode: mode, status: 'validated', note: '', maintenance_id: null, created_by: paid_by, created_at: now(), version: 1 });
    const inputs = mode === 'single' ? [{ user_id: paid_by === A ? B : A }] : [{ user_id: A, value: pct?.[0] }, { user_id: B, value: pct?.[1] }];
    for (const s of computeShares(cents, mode, inputs)) d.expense_shares.push({ expense_id: id, household_id: h, ...s });
  };
  addExp('Loyer', 120000, `${month}-01`, 'Loyer', A);
  addExp('Box internet', 2999, `${month}-05`, 'Internet', B);
  addExp('Courses Carrefour', 6420, addDays(t, -6), 'Courses alimentaires', A);
  addExp('Produits ménagers', 1835, addDays(t, -4), 'Produits ménagers', B);
  addExp('Électricité', 8400, addDays(t, -10), 'Électricité et gaz', A, 'percent', [60, 40]);
  addExp('Place de cinéma', 1150, addDays(t, -2), 'Autres dépenses', A, 'single');
  const prev = toISO(new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1));
  addExp('Loyer', 120000, prev, 'Loyer', A);
  addExp('Courses', 9280, addDays(prev, 12), 'Courses alimentaires', B);
  d.reimbursements.push({ id: uuid(), household_id: h, client_key: uuid(), from_user: B, to_user: A, amount_cents: 60000, date: addDays(prev, 2), note: 'Loyer', status: 'done', created_by: B, created_at: now(), version: 1 });
  const [y, m] = month.split('-').map(Number);
  d.budgets.push({ id: uuid(), household_id: h, period: 'month', year: y, month: m, total_cents: 160000, category_limits: { [cat('Courses alimentaires')]: 25000, [cat('Produits ménagers')]: 3000 }, version: 1 });
  d.budgets.push({ id: uuid(), household_id: h, period: 'year', year: y, month: 0, total_cents: 1900000, category_limits: {}, version: 1 });

  // Courses, stocks, entretien
  const shop = (name: string, category: string, extra: Row = {}) => d.shopping_items.push({ id: uuid(), household_id: h, name, quantity: 1, unit: '', category, priority: 'normal', assigned_to: null, status: 'to_buy', note: '', price_estimate_cents: null, stock_id: null, bought_at: null, bought_by: null, created_by: A, created_at: now(), version: 1, ...extra });
  shop('Lait', 'Alimentation', { quantity: 2, unit: 'L' });
  shop('Éponges', 'Produits ménagers', { quantity: 3, priority: 'high', price_estimate_cents: 250 });
  shop('Pain de mie', 'Alimentation', { assigned_to: B });
  shop('Café', 'Alimentation', { status: 'bought', bought_at: addDays(t, -1) + 'T10:00:00.000Z', bought_by: B, price_estimate_cents: 590 });
  const stock = (name: string, quantity: number, min_threshold: number, location: string, unit = '') => d.stocks.push({ id: uuid(), household_id: h, name, quantity, unit, min_threshold, location, updated_at: now(), version: 1 });
  stock('Papier toilette', 3, 4, 'Placard WC', 'rouleaux');
  stock('Lessive', 1, 1, 'Sous l’évier', 'bidon');
  stock('Liquide vaisselle', 2, 1, 'Cuisine', 'flacons');
  stock('Sacs-poubelle', 20, 10, 'Cuisine', 'sacs');
  stock('Éponges', 0, 2, 'Cuisine');
  d.maintenance.push({ id: uuid(), household_id: h, title: 'Ampoule de l’entrée grillée', description: 'Culot E27, 60 W équivalent.', category: 'Électricité', reported_at: addDays(t, -3), priority: 'normal', owner: B, due_date: addDays(t, 2), status: 'todo', created_by: A, created_at: now(), version: 1 });
  d.maintenance.push({ id: uuid(), household_id: h, title: 'Joint du robinet de la cuisine qui fuit', description: 'Goutte à goutte. Prévenir le propriétaire.', category: 'Plomberie', reported_at: addDays(t, -9), priority: 'high', owner: A, due_date: addDays(t, -1), status: 'in_progress', created_by: B, created_at: now(), version: 1 });

  d.notifications.push({ id: uuid(), household_id: h, user_id: A, type: 'expense', title: 'Nouvelle dépense : Produits ménagers', body: 'Sam a ajouté 18,35 €', link: '/budget', read_at: null, created_at: now() });
  d.notifications.push({ id: uuid(), household_id: h, user_id: B, type: 'stock', title: 'Bientôt épuisé : Papier toilette', body: 'Quantité : 3', link: '/courses', read_at: null, created_at: now() });
  return d;
}
