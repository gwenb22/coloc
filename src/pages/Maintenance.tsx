import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { backend } from '../backend';
import { useData } from '../store';
import type { Maintenance } from '../types';
import { Empty, Field, Icon, Modal, Person, PersonSelect, Seg } from '../components/ui';
import { useModals } from '../components/Modals';
import { fmtDate, fmtDateTime, relativeDay, today } from '../lib/dates';
import { formatMoney } from '../lib/money';
import { cx } from '../lib/util';

const PRIORITY: Record<Maintenance['priority'], { label: string; cls: string }> = {
  low: { label: 'Basse', cls: '' }, normal: { label: 'Normale', cls: 'info' }, high: { label: 'Haute', cls: 'warning' }, urgent: { label: 'Urgente', cls: 'danger' },
};
const STATUS: Record<Maintenance['status'], { label: string; cls: string }> = {
  todo: { label: 'À traiter', cls: 'outline' }, in_progress: { label: 'En cours', cls: 'info' }, resolved: { label: 'Résolu', cls: 'success' }, abandoned: { label: 'Abandonné', cls: '' },
};
const CATEGORIES = ['Plomberie', 'Électricité', 'Électroménager', 'Chauffage', 'Serrurerie', 'Mobilier', 'Propriétaire / agence', 'Autre'];
const ORDER = { urgent: 0, high: 1, normal: 2, low: 3 };

export default function MaintenancePage() {
  const { data } = useData();
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState<'open' | 'closed' | 'all'>('open');
  const [creating, setCreating] = useState(false);
  const openId = params.get('id');
  const t = today();
  const list = data.maintenance
    .filter((m) => (filter === 'all' ? true : filter === 'open' ? m.status === 'todo' || m.status === 'in_progress' : m.status === 'resolved' || m.status === 'abandoned'))
    .sort((a, b) => ORDER[a.priority] - ORDER[b.priority] || (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999'));
  const current = openId ? data.maintenance.find((m) => m.id === openId) : null;

  return (
    <>
      <div className="page-head">
        <div className="grow"><h2>Entretien et réparations</h2><p>Problèmes, équipements et suivi avec le propriétaire.</p></div>
        <button className="btn btn-primary" onClick={() => setCreating(true)}><Icon name="plus" />Signaler un problème</button>
      </div>
      <Seg value={filter} onChange={setFilter} options={[{ value: 'open', label: 'En cours' }, { value: 'closed', label: 'Clos' }, { value: 'all', label: 'Tous' }]} />
      <div className="card">
        <div className="list">
          {list.length === 0 && <Empty icon="tool">Rien à signaler.</Empty>}
          {list.map((m) => {
            const late = m.due_date && m.due_date < t && (m.status === 'todo' || m.status === 'in_progress');
            return (
              <div key={m.id} className={cx('list-item clickable', late && 'is-late')} onClick={() => setParams({ id: m.id })}>
                <div className="grow">
                  <div className="title ellipsis">{m.title}</div>
                  <div className="meta">
                    <span className={cx('badge', STATUS[m.status].cls)}>{STATUS[m.status].label}</span>
                    <span className={cx('badge', PRIORITY[m.priority].cls)}>{PRIORITY[m.priority].label}</span>
                    <span>{m.category}</span>
                    {m.due_date && <span className={late ? 'danger-text strong' : ''}>échéance {relativeDay(m.due_date)}</span>}
                    <span className="hide-sm">signalé le {fmtDate(m.reported_at)}</span>
                  </div>
                </div>
                {m.owner && <Person id={m.owner} you={false} />}
              </div>
            );
          })}
        </div>
      </div>
      {(creating || current) && <MaintenanceModal item={creating ? null : current!} onClose={() => { setCreating(false); setParams({}); }} />}
    </>
  );
}

function MaintenanceModal({ item, onClose }: { item: Maintenance | null; onClose: () => void }) {
  const { data, run, meId, name } = useData();
  const { openExpense } = useModals();
  const [f, setF] = useState<Partial<Maintenance>>(() => item ? { ...item } : { title: '', description: '', category: 'Autre', priority: 'normal', owner: meId, due_date: null, status: 'todo', reported_at: today() });
  const [comment, setComment] = useState('');
  const [err, setErr] = useState('');
  const set = <K extends keyof Maintenance>(k: K, v: Maintenance[K]) => setF((x) => ({ ...x, [k]: v }));
  const comments = item ? data.comments.filter((c) => c.entity === 'maintenance' && c.entity_id === item.id).sort((a, b) => a.created_at.localeCompare(b.created_at)) : [];
  const history = item ? data.activity_log.filter((l) => l.entity === 'maintenance' && l.entity_id === item.id).sort((a, b) => a.created_at.localeCompare(b.created_at)) : [];
  const expenses = item ? data.expenses.filter((e) => e.maintenance_id === item.id) : [];

  const save = async (patch?: Partial<Maintenance>) => {
    setErr('');
    const v = { ...f, ...patch };
    if (!v.title?.trim()) return setErr('Indiquez un titre.');
    const payload = { title: v.title.trim(), description: v.description ?? '', category: v.category ?? 'Autre', priority: v.priority ?? 'normal', owner: v.owner ?? null, due_date: v.due_date || null, status: v.status ?? 'todo', reported_at: v.reported_at ?? today() };
    const r = await run<unknown>(() => item ? backend.update('maintenance', item.id, payload, item.version) : backend.insert('maintenance', { ...payload, household_id: data.household.id, created_by: meId }),
      { success: patch?.status === 'resolved' ? 'Marqué comme résolu' : item ? 'Fiche mise à jour' : 'Problème signalé', tables: ['maintenance'], key: 'maint' });
    if (r) onClose();
  };

  const describe = (d: Record<string, unknown>, action: string) => {
    if (action === 'insert') return 'création de la fiche';
    const b = d.before as Partial<Maintenance> | undefined, a = d.after as Partial<Maintenance> | undefined;
    if (!a || !b) return action;
    const ch: string[] = [];
    if (b.status !== a.status) ch.push(`statut → ${STATUS[a.status!]?.label}`);
    if (b.priority !== a.priority) ch.push(`priorité → ${PRIORITY[a.priority!]?.label}`);
    if (b.owner !== a.owner) ch.push(`suivi → ${name(a.owner)}`);
    if (b.due_date !== a.due_date) ch.push(`échéance → ${a.due_date ? fmtDate(a.due_date) : 'aucune'}`);
    return ch.join(', ') || 'informations modifiées';
  };

  return (
    <Modal title={item ? item.title : 'Signaler un problème'} onClose={onClose} wide footer={
      <>
        {item && item.status !== 'resolved' && <button className="btn" style={{ marginRight: 'auto' }} onClick={() => save({ status: 'resolved' })}><Icon name="check" size={15} />Marquer résolu</button>}
        <button className="btn" onClick={onClose}>Fermer</button>
        <button className="btn btn-primary" onClick={() => save()}>Enregistrer</button>
      </>
    }>
      <div className="form-grid">
        <Field label="Équipement ou problème" className="full"><input className="input" value={f.title} onChange={(e) => set('title', e.target.value)} placeholder="Ex. : fuite sous l’évier" maxLength={120} /></Field>
        <Field label="Description" className="full"><textarea className="textarea" value={f.description} onChange={(e) => set('description', e.target.value)} /></Field>
        <Field label="Catégorie"><select className="select" value={f.category} onChange={(e) => set('category', e.target.value)}>{CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select></Field>
        <Field label="Priorité"><select className="select" value={f.priority} onChange={(e) => set('priority', e.target.value as Maintenance['priority'])}>{Object.entries(PRIORITY).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></Field>
        <Field label="Suivi par"><PersonSelect value={f.owner ?? null} allowNone noneLabel="Personne" onChange={(v) => set('owner', v)} /></Field>
        <Field label="Échéance (facultative)"><input type="date" className="input" value={f.due_date ?? ''} onChange={(e) => set('due_date', e.target.value || null)} /></Field>
        <Field label="Statut"><select className="select" value={f.status} onChange={(e) => set('status', e.target.value as Maintenance['status'])}>{Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></Field>
        <Field label="Signalé le"><input type="date" className="input" value={f.reported_at ?? ''} onChange={(e) => set('reported_at', e.target.value)} /></Field>
      </div>
      {err && <div className="error-box">{err}</div>}

      {item && (
        <>
          <div className="stack-sm">
            <div className="row between"><h3>Dépenses liées</h3><button className="btn btn-sm" onClick={() => openExpense(null, { title: item.title, category_name: 'Réparations et entretien', maintenance_id: item.id })}><Icon name="plus" size={14} />Ajouter une dépense</button></div>
            {expenses.length === 0 ? <p className="small muted">Aucune dépense liée. La dépense n’est jamais créée automatiquement.</p> :
              expenses.map((e) => <div key={e.id} className="row between small"><span>{fmtDate(e.date)} · {e.title}{e.status !== 'validated' && ` (${e.status === 'draft' ? 'provisoire' : 'annulée'})`}</span><b className="num">{formatMoney(e.amount_cents, data.household.currency)}</b></div>)}
          </div>
          <div className="stack-sm">
            <h3>Commentaires et actions</h3>
            {comments.map((c) => <div key={c.id} className="comment"><b>{name(c.user_id)}</b> <span className="xs muted">{fmtDateTime(c.created_at)}</span><div>{c.body}</div></div>)}
            <form className="row" onSubmit={async (e) => {
              e.preventDefault();
              if (!comment.trim()) return;
              const r = await run(() => backend.insert('comments', { household_id: data.household.id, entity: 'maintenance', entity_id: item.id, user_id: meId, body: comment.trim() }), { tables: ['comments'], key: 'mcomment' });
              if (r) setComment('');
            }}>
              <input className="input" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Ex. : propriétaire appelé, intervention jeudi" />
              <button className="btn" aria-label="Envoyer"><Icon name="message" /></button>
            </form>
          </div>
          {history.length > 0 && (
            <details>
              <summary className="small strong" style={{ cursor: 'pointer' }}>Historique</summary>
              <ul className="timeline" style={{ marginTop: 8 }}>
                {history.map((h) => <li key={h.id}><span className="muted nowrap">{fmtDateTime(h.created_at)}</span><span>{name(h.user_id)} — {describe(h.details, h.action)}</span></li>)}
              </ul>
            </details>
          )}
        </>
      )}
    </Modal>
  );
}
