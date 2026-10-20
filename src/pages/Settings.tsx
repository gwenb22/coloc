import { useState } from 'react';
import { backend, leaveDemo } from '../backend';
import { resetDemo } from '../backend/demo';
import { applyTheme, useData } from '../store';
import type { Category, Effort, HouseholdSettings, NotifPrefs, NotifType, Profile, SplitMode, UiPrefs, Zone } from '../types';
import { Field, Icon, Person, Seg, useConfirm } from '../components/ui';
import { NOTIF_LABELS } from './Notifications';
import { DEFAULT_COEF, EFFORT_LABEL } from '../lib/fairness';
import { centsCSV, download, toCSV } from '../lib/csv';
import { MONTHS, today } from '../lib/dates';
import { errorMessage } from '../lib/util';

export default function SettingsPage() {
  return (
    <>
      <div className="page-head"><div className="grow"><h2>Paramètres</h2><p>Préférences personnelles, colocation, sécurité et exports.</p></div></div>
      <div className="grid grid-2" style={{ alignItems: 'start' }}>
        <div className="stack">
          <ProfileCard />
          <NotificationsCard />
          <AccountCard />
        </div>
        <div className="stack">
          <HouseholdCard />
          <ZonesCard />
          <CategoriesCard />
          <PlanningCard />
          <ExportCard />
        </div>
      </div>
    </>
  );
}

function useProfileUpdate() {
  const { me, run } = useData();
  return (patch: Partial<Profile>, success = 'Préférences enregistrées') => me && run(() => backend.update('profiles', me.id, patch), { success, tables: ['profiles'], key: 'profile' });
}

function ProfileCard() {
  const { me } = useData();
  const update = useProfileUpdate();
  const [nameV, setName] = useState(me?.display_name ?? '');
  const ui = me?.ui_prefs ?? {};
  const setUi = (p: Partial<UiPrefs>) => update({ ui_prefs: { ...ui, ...p } });
  return (
    <div className="card">
      <div className="card-head"><h2>Profil</h2></div>
      <div className="card-body stack">
        <form className="row" onSubmit={(e) => { e.preventDefault(); if (nameV.trim()) update({ display_name: nameV.trim() }, 'Nom modifié'); }}>
          <Field label="Nom d’affichage" className="grow"><input className="input" value={nameV} onChange={(e) => setName(e.target.value)} maxLength={40} /></Field>
          <button className="btn" style={{ alignSelf: 'flex-end' }} disabled={nameV.trim() === me?.display_name}>Enregistrer</button>
        </form>
        <Field label="Apparence">
          <Seg value={ui.theme ?? 'system'} onChange={(v) => { applyTheme(v); setUi({ theme: v }); }} options={[{ value: 'system', label: 'Automatique' }, { value: 'light', label: 'Clair' }, { value: 'dark', label: 'Sombre' }]} />
        </Field>
        <Field label="Vue par défaut du calendrier">
          <Seg value={ui.calendar_view ?? 'month'} onChange={(v) => setUi({ calendar_view: v })} options={[{ value: 'month', label: 'Mois' }, { value: 'week', label: 'Semaine' }, { value: 'day', label: 'Jour' }, { value: 'upcoming', label: 'Échéances' }]} />
        </Field>
        <label className="toggle"><input type="checkbox" checked={!!ui.calendar_show_expenses} onChange={(e) => setUi({ calendar_show_expenses: e.target.checked })} />Afficher les dépenses dans le calendrier par défaut</label>
      </div>
    </div>
  );
}

function NotificationsCard() {
  const { me, toast } = useData();
  const update = useProfileUpdate();
  const p: NotifPrefs = me?.notif_prefs ?? {};
  const set = (patch: Partial<NotifPrefs>) => update({ notif_prefs: { ...p, ...patch } });
  const supported = typeof Notification !== 'undefined';
  const [perm, setPerm] = useState(supported ? Notification.permission : 'denied');

  const enableBrowser = async (on: boolean) => {
    if (!on) return set({ browser: false });
    if (!supported) return toast('Ce navigateur ne prend pas en charge les notifications.', 'error');
    const r = await Notification.requestPermission();
    setPerm(r);
    if (r === 'granted') set({ browser: true });
    else toast('Autorisation refusée : réactivez-la dans les réglages du navigateur.', 'error');
  };

  return (
    <div className="card">
      <div className="card-head"><h2>Notifications et rappels</h2></div>
      <div className="card-body stack">
        <label className="toggle"><input type="checkbox" checked={p.enabled !== false} onChange={(e) => set({ enabled: e.target.checked })} />Recevoir des notifications dans l’application</label>
        <label className="toggle"><input type="checkbox" checked={!!p.browser && perm === 'granted'} onChange={(e) => enableBrowser(e.target.checked)} disabled={!supported} />Notifications du navigateur {perm === 'denied' && supported && <span className="xs danger-text">(bloquées par le navigateur)</span>}</label>
        <p className="xs muted">Les notifications du navigateur s’affichent quand l’application est ouverte ou en arrière-plan. Sur iPhone, installez d’abord l’application sur l’écran d’accueil. Les rappels quotidiens côté serveur sont optionnels (voir le guide).</p>
        <div className="form-section">
          <h4>Catégories</h4>
          <div className="form-grid">
            {(Object.keys(NOTIF_LABELS) as NotifType[]).map((k) => (
              <label key={k} className="toggle"><input type="checkbox" checked={p.categories?.[k] !== false} disabled={p.enabled === false} onChange={(e) => set({ categories: { ...p.categories, [k]: e.target.checked } })} />{NOTIF_LABELS[k]}</label>
            ))}
          </div>
        </div>
        <div className="form-section">
          <h4>Horaires</h4>
          <div className="form-grid">
            <Field label="Rappel des tâches du jour à partir de"><input type="time" className="input" value={p.reminder_hour ?? '08:00'} onChange={(e) => set({ reminder_hour: e.target.value })} /></Field>
            <div />
            <Field label="Silence de"><input type="time" className="input" value={p.quiet_start ?? ''} onChange={(e) => set({ quiet_start: e.target.value })} /></Field>
            <Field label="à"><input type="time" className="input" value={p.quiet_end ?? ''} onChange={(e) => set({ quiet_end: e.target.value })} /></Field>
          </div>
        </div>
      </div>
    </div>
  );
}

function AccountCard() {
  const { user, toast } = useData();
  const confirm = useConfirm();
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const demo = backend.mode === 'demo';

  const changePw = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pw.length < 8) return toast('Au moins 8 caractères.', 'error');
    setBusy(true);
    try {
      await backend.updatePassword(pw);
      setPw('');
      toast('Mot de passe modifié.');
    } catch (er) {
      toast(errorMessage(er), 'error');
    } finally {
      setBusy(false);
    }
  };

  const deleteAccount = async () => {
    const ok = await confirm({
      title: 'Supprimer définitivement votre compte ?',
      message: <>Vous quitterez la colocation et votre connexion sera supprimée. Les dépenses, remboursements et tâches passés restent visibles par votre colocataire (sous le nom « Ancien membre ») afin que les comptes restent justes. <b>Pensez à régler le solde et à exporter vos données avant.</b> Action irréversible.</>,
      confirm: 'Supprimer mon compte', danger: true,
    });
    if (!ok) return;
    try {
      await backend.rpc('delete_my_account');
      await backend.signOut();
    } catch (er) {
      toast(errorMessage(er), 'error');
    }
  };

  return (
    <div className="card">
      <div className="card-head"><h2>Compte et sécurité</h2></div>
      <div className="card-body stack">
        <div className="small">Connecté·e avec <b>{user?.email}</b></div>
        {!demo && (
          <form className="row" onSubmit={changePw}>
            <Field label="Nouveau mot de passe" className="grow"><input type="password" className="input" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" /></Field>
            <button className="btn" style={{ alignSelf: 'flex-end' }} disabled={busy || !pw}>Changer</button>
          </form>
        )}
        <div className="row-wrap">
          <button className="btn" onClick={() => backend.signOut()}><Icon name="logout" size={15} />Se déconnecter</button>
          {demo ? (
            <>
              <button className="btn" onClick={async () => { if (await confirm({ title: 'Réinitialiser la démo ?', message: 'Toutes les données de démonstration de ce navigateur seront recréées.', danger: true, confirm: 'Réinitialiser' })) { resetDemo(); window.location.reload(); } }}>Réinitialiser la démo</button>
              {import.meta.env.VITE_SUPABASE_URL && <button className="btn btn-ghost" onClick={leaveDemo}>Quitter la démo</button>}
            </>
          ) : <button className="btn btn-danger" onClick={deleteAccount}>Supprimer mon compte…</button>}
        </div>
      </div>
    </div>
  );
}

function HouseholdCard() {
  const { data, run, meId, memberIds, toast } = useData();
  const confirm = useConfirm();
  const h = data.household;
  const [nameV, setName] = useState(h.name);
  const isOwner = data.members.find((m) => m.user_id === meId)?.role === 'owner';
  const link = h.invite_code ? `${window.location.origin}${window.location.pathname}#/rejoindre/${h.invite_code}` : '';
  const upd = (patch: Partial<typeof h>, success = 'Colocation mise à jour') => run(() => backend.update('households', h.id, patch, h.version), { success, tables: ['households'], key: 'house' });

  const share = async () => {
    const text = `Rejoins notre colocation « ${h.name} » sur Coloc : ${link} (code ${h.invite_code})`;
    try {
      if (navigator.share) await navigator.share({ title: 'Invitation Coloc', text, url: link });
      else {
        await navigator.clipboard.writeText(text);
        toast('Invitation copiée dans le presse-papiers.');
      }
    } catch {
      /* partage annulé */
    }
  };

  return (
    <div className="card">
      <div className="card-head"><h2>Colocation</h2></div>
      <div className="card-body stack">
        <form className="row" onSubmit={(e) => { e.preventDefault(); if (nameV.trim()) upd({ name: nameV.trim() }); }}>
          <Field label="Nom" className="grow"><input className="input" value={nameV} onChange={(e) => setName(e.target.value)} maxLength={80} /></Field>
          <button className="btn" style={{ alignSelf: 'flex-end' }} disabled={nameV.trim() === h.name}>Enregistrer</button>
        </form>
        <div className="form-grid">
          <Field label="Devise">
            <select className="select" value={h.currency} onChange={(e) => upd({ currency: e.target.value })}>
              {['EUR', 'CHF', 'GBP', 'USD', 'CAD', 'XOF', 'MAD'].map((c) => <option key={c}>{c}</option>)}
            </select>
          </Field>
          <Field label="Début du suivi"><input type="date" className="input" value={h.start_date} onChange={(e) => e.target.value && upd({ start_date: e.target.value })} /></Field>
        </div>

        <div className="form-section">
          <h4>Membres ({memberIds.length}/2)</h4>
          {data.members.map((m) => (
            <div key={m.user_id} className="row between">
              <Person id={m.user_id} />
              <span className="row" style={{ gap: 6 }}>
                <span className="badge">{m.role === 'owner' ? 'Gestionnaire' : 'Membre'}</span>
                {isOwner && m.user_id !== meId && <button className="btn btn-ghost btn-sm" onClick={async () => {
                  if (await confirm({ title: 'Transférer le rôle de gestionnaire ?', message: 'Les deux membres ont toujours les mêmes droits sur les données communes ; ce rôle sert uniquement à gérer la colocation.' })) run(() => backend.rpc('transfer_owner', { p_user: m.user_id }), { success: 'Rôle transféré', tables: ['household_members'] });
                }}>Transférer le rôle</button>}
              </span>
            </div>
          ))}
          {memberIds.length < 2 && (
            <div className="card card-pad stack-sm" style={{ background: 'var(--accent-soft)', borderColor: 'transparent' }}>
              <b>Inviter votre colocataire</b>
              {h.invite_code ? (
                <>
                  <div className="row-wrap"><span className="small">Code :</span><code style={{ fontSize: 18, fontWeight: 700, letterSpacing: '.12em' }}>{h.invite_code}</code></div>
                  <span className="xs muted" style={{ wordBreak: 'break-all' }}>{link}</span>
                  <div className="row-wrap">
                    <button className="btn btn-sm btn-primary" onClick={share}><Icon name="share" size={14} />Partager le lien</button>
                    <button className="btn btn-sm" onClick={() => navigator.clipboard.writeText(link).then(() => toast('Lien copié.'))}><Icon name="copy" size={14} />Copier</button>
                    <button className="btn btn-sm btn-ghost" onClick={() => run(() => backend.rpc('regenerate_invite'), { success: 'Nouveau code généré (l’ancien ne fonctionne plus)', tables: ['households'] })}><Icon name="refresh" size={14} />Nouveau code</button>
                  </div>
                  <span className="xs">Votre colocataire crée son compte, puis saisit ce code (ou ouvre le lien). Le code devient inutilisable dès que la colocation est complète.</span>
                </>
              ) : <button className="btn btn-sm" onClick={() => run(() => backend.rpc('regenerate_invite'), { success: 'Code généré', tables: ['households'] })}>Générer un code d’invitation</button>}
            </div>
          )}
        </div>
        {backend.mode !== 'demo' && (
          <button className="btn btn-danger btn-sm" style={{ alignSelf: 'flex-start' }} onClick={async () => {
            if (await confirm({ title: 'Quitter la colocation ?', message: 'Les données communes et l’historique restent pour l’autre membre. Vos tâches futures non terminées ne seront plus attribuées. Réglez le solde avant de partir.', confirm: 'Quitter', danger: true })) {
              const r = await run(() => backend.rpc('leave_household'));
              if (r !== undefined) window.location.reload();
            }
          }}>Quitter la colocation…</button>
        )}
      </div>
    </div>
  );
}

function ZonesCard() {
  const { data, run } = useData();
  const [newName, setNewName] = useState('');
  const [newIcon, setNewIcon] = useState('🏠');
  const zones = [...data.zones].sort((a, b) => a.position - b.position);
  const upd = (z: Zone, patch: Partial<Zone>, success?: string) => run(() => backend.update('zones', z.id, patch, z.version), { success, tables: ['zones'] });
  return (
    <div className="card">
      <div className="card-head"><h2>Espaces communs</h2><span className="small muted">Les chambres sont hors périmètre</span></div>
      <div className="list">
        {zones.map((z) => (
          <div key={z.id} className="list-item">
            <input className="input input-sm" style={{ width: 52, textAlign: 'center' }} defaultValue={z.icon} maxLength={4} onBlur={(e) => e.target.value !== z.icon && upd(z, { icon: e.target.value || '🏠' })} aria-label="Icône" />
            <input className="input input-sm grow" defaultValue={z.name} onBlur={(e) => e.target.value.trim() && e.target.value !== z.name && upd(z, { name: e.target.value.trim() }, 'Zone renommée')} aria-label="Nom de la zone" />
            <label className="toggle small"><input type="checkbox" checked={z.active} onChange={(e) => upd(z, { active: e.target.checked }, e.target.checked ? 'Zone activée' : 'Zone désactivée')} />Active</label>
          </div>
        ))}
      </div>
      <form className="card-foot" onSubmit={async (e) => {
        e.preventDefault();
        if (!newName.trim()) return;
        const r = await run(() => backend.insert('zones', { household_id: data.household.id, name: newName.trim(), icon: newIcon || '🏠', position: zones.length + 1 }), { success: 'Espace ajouté', tables: ['zones'], key: 'zone' });
        if (r) setNewName('');
      }}>
        <input className="input input-sm" style={{ width: 52, textAlign: 'center' }} value={newIcon} onChange={(e) => setNewIcon(e.target.value)} maxLength={4} aria-label="Icône" />
        <input className="input input-sm grow" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Nouvel espace (ex. : buanderie)" />
        <button className="btn btn-sm"><Icon name="plus" size={14} />Ajouter</button>
      </form>
      <div className="card-foot xs muted">Désactiver une zone masque ses tâches de la planification sans effacer l’historique.</div>
    </div>
  );
}

function CategoriesCard() {
  const { data, run } = useData();
  const [kind, setKind] = useState<Category['kind']>('expense');
  const [newName, setNewName] = useState('');
  const list = data.categories.filter((c) => c.kind === kind).sort((a, b) => a.position - b.position);
  return (
    <div className="card">
      <div className="card-head"><h2>Catégories</h2><Seg value={kind} onChange={setKind} options={[{ value: 'expense', label: 'Dépenses' }, { value: 'shopping', label: 'Courses' }]} /></div>
      <div className="list">
        {list.map((c) => (
          <div key={c.id} className="list-item" style={{ minHeight: 48 }}>
            <input className="input input-sm grow" defaultValue={c.name} disabled={c.archived} onBlur={(e) => e.target.value.trim() && e.target.value !== c.name && run(() => backend.update('categories', c.id, { name: e.target.value.trim() }, c.version), { success: 'Catégorie renommée', tables: ['categories'] })} aria-label="Nom" />
            <button className="btn btn-ghost btn-sm" onClick={() => run(() => backend.update('categories', c.id, { archived: !c.archived }, c.version), { tables: ['categories'] })}>{c.archived ? 'Réactiver' : 'Archiver'}</button>
          </div>
        ))}
      </div>
      <form className="card-foot" onSubmit={async (e) => {
        e.preventDefault();
        if (!newName.trim()) return;
        const r = await run(() => backend.insert('categories', { household_id: data.household.id, kind, name: newName.trim(), position: list.length + 1 }), { success: 'Catégorie ajoutée', tables: ['categories'], key: 'cat' });
        if (r) setNewName('');
      }}>
        <input className="input input-sm grow" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Nouvelle catégorie" />
        <button className="btn btn-sm"><Icon name="plus" size={14} />Ajouter</button>
      </form>
    </div>
  );
}

function PlanningCard() {
  const { data, run } = useData();
  const h = data.household;
  const s = h.settings;
  const coef = { ...DEFAULT_COEF, ...(s.effort_coef ?? {}) };
  const upd = (patch: Partial<HouseholdSettings>) => run(() => backend.update('households', h.id, { settings: { ...s, ...patch } }, h.version), { success: 'Réglage enregistré', tables: ['households'], key: 'settings' });
  return (
    <div className="card">
      <div className="card-head"><h2>Répartition et partage</h2></div>
      <div className="card-body stack">
        <div className="form-section">
          <h4>Coefficients d’effort</h4>
          <div className="form-grid" style={{ gridTemplateColumns: 'repeat(3, minmax(0,1fr))' }}>
            {(Object.keys(EFFORT_LABEL) as Effort[]).map((e) => (
              <Field key={e} label={EFFORT_LABEL[e]}>
                <input className="input input-sm" type="number" step="0.1" min="0.5" max="5" defaultValue={coef[e]} onBlur={(ev) => {
                  const v = Number(ev.target.value);
                  if (v >= 0.5 && v <= 5 && v !== coef[e]) upd({ effort_coef: { ...coef, [e]: v } });
                }} />
              </Field>
            ))}
          </div>
          <p className="xs muted">Charge = durée estimée × coefficient. Ces valeurs sont des points de départ à ajuster entre vous ; elles s’appliquent aux nouvelles planifications (l’historique garde ses valeurs).</p>
        </div>
        <div className="form-grid">
          <Field label="Fenêtre de référence">
            <select className="select" value={s.window_weeks ?? 4} onChange={(e) => upd({ window_weeks: Number(e.target.value) })}>
              {[2, 3, 4, 6, 8].map((n) => <option key={n} value={n}>{n} semaines glissantes</option>)}
            </select>
          </Field>
          <Field label="Partage par défaut des dépenses">
            <select className="select" value={s.default_split ?? 'equal'} onChange={(e) => upd({ default_split: e.target.value as SplitMode })}>
              <option value="equal">Parts égales (50/50)</option><option value="percent">Pourcentage</option><option value="fixed">Montants fixes</option><option value="single">Une seule personne</option>
            </select>
          </Field>
        </div>
        <label className="toggle"><input type="checkbox" checked={s.avoid_repeats !== false} onChange={(e) => upd({ avoid_repeats: e.target.checked })} />Éviter qu’une même tâche revienne toujours à la même personne</label>
        <label className="toggle"><input type="checkbox" checked={!!s.enable_in_progress} onChange={(e) => upd({ enable_in_progress: e.target.checked })} />Activer le statut « En cours »</label>
      </div>
    </div>
  );
}

function ExportCard() {
  const { data, name, category, zone } = useData();
  const d = today();
  const dl = (file: string, rows: (string | number | null | undefined)[][]) => download(`${file}-${d}.csv`, toCSV(rows));
  const exports = [
    { label: 'Dépenses', run: () => dl('depenses', [['Date', 'Titre', 'Catégorie', 'Montant', 'Payé par', 'Mode', ...data.members.map((m) => `Part ${name(m.user_id)}`), 'Statut', 'Note'],
      ...data.expenses.map((e) => [e.date, e.title, category(e.category_id)?.name, centsCSV(e.amount_cents), name(e.paid_by), e.split_mode, ...data.members.map((m) => centsCSV(data.expense_shares.find((s) => s.expense_id === e.id && s.user_id === m.user_id)?.share_cents ?? 0)), e.status, e.note])]) },
    { label: 'Remboursements', run: () => dl('remboursements', [['Date', 'De', 'À', 'Montant', 'Statut', 'Commentaire'], ...data.reimbursements.map((r) => [r.date, name(r.from_user), name(r.to_user), centsCSV(r.amount_cents), r.status, r.note])]) },
    { label: 'Historique des tâches', run: () => dl('taches', [['Date', 'Tâche', 'Zone', 'Attribuée à', 'Statut', 'Réalisée le', 'Par', 'Estimé (min)', 'Réel (min)', 'Charge'], ...data.task_occurrences.filter((o) => !o.proposed).sort((a, b) => a.due_date.localeCompare(b.due_date)).map((o) => [o.due_date, o.name, zone(o.zone_id)?.name, name(o.assigned_to), o.status, o.done_at ?? '', o.done_by ? name(o.done_by) : '', o.estimated_min, o.actual_min ?? '', String(o.weight).replace('.', ',')])]) },
    { label: 'Liste de courses', run: () => dl('courses', [['Article', 'Quantité', 'Unité', 'Catégorie', 'Priorité', 'Statut', 'Acheteur·se', 'Prix estimé', 'Note'], ...data.shopping_items.filter((s) => s.status !== 'deleted').map((s) => [s.name, s.quantity, s.unit, s.category, s.priority, s.status, s.assigned_to ? name(s.assigned_to) : '', centsCSV(s.price_estimate_cents), s.note])]) },
    { label: 'Budgets', run: () => dl('budgets', [['Période', 'Année', 'Mois', 'Montant prévu', 'Limites par catégorie'], ...data.budgets.map((b) => [b.period === 'year' ? 'Annuel' : 'Mensuel', b.year, b.month ? MONTHS[b.month - 1] : '', centsCSV(b.total_cents), Object.entries(b.category_limits).map(([k, v]) => `${category(k)?.name}: ${centsCSV(v)}`).join(' | ')])]) },
  ];
  const json = () => {
    const { notifications, ...rest } = data;
    download(`coloc-sauvegarde-${d}.json`, JSON.stringify({ exported_at: new Date().toISOString(), format: 'coloc-v1', ...rest, my_notifications: notifications }, null, 2), 'application/json');
  };
  return (
    <div className="card">
      <div className="card-head"><h2>Sauvegarde et export</h2></div>
      <div className="card-body stack">
        <div className="row-wrap">
          {exports.map((e) => <button key={e.label} className="btn btn-sm" onClick={e.run}><Icon name="download" size={14} />{e.label}</button>)}
        </div>
        <button className="btn btn-sm" style={{ alignSelf: 'flex-start' }} onClick={json}><Icon name="download" size={14} />Sauvegarde complète (JSON)</button>
        <p className="xs muted">Les exports contiennent uniquement les données de votre colocation auxquelles vous avez accès. Fichiers CSV au format Excel français (séparateur « ; »).</p>
      </div>
    </div>
  );
}
