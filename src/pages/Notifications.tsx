import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { backend } from '../backend';
import { useData } from '../store';
import type { NotifType } from '../types';
import { Empty, Icon, Seg } from '../components/ui';
import { SwapActions, useModals } from '../components/Modals';
import { fmtDate, fmtDateTime } from '../lib/dates';
import { cx } from '../lib/util';

export const NOTIF_LABELS: Record<NotifType, string> = {
  task_due: 'Tâches du jour', task_overdue: 'Tâches en retard', task_assigned: 'Attributions', swap: 'Échanges',
  reimbursement: 'Remboursements', expense: 'Dépenses', shopping: 'Courses', stock: 'Stocks', maintenance: 'Entretien', member: 'Colocation',
};
const ICONS: Record<string, string> = { task_due: 'tasks', task_overdue: 'alert', task_assigned: 'user', swap: 'swap', reimbursement: 'scale', expense: 'wallet', shopping: 'cart', stock: 'box', maintenance: 'tool', member: 'home' };

export default function NotificationsPage() {
  const { data, run, meId, name } = useData();
  const { openOccurrence } = useModals();
  const nav = useNavigate();
  const [filter, setFilter] = useState<'unread' | 'all'>('unread');
  const [type, setType] = useState<string>('all');
  const swapsIn = data.swap_requests.filter((s) => s.status === 'pending' && s.to_user === meId);
  const swapsOut = data.swap_requests.filter((s) => s.status === 'pending' && s.from_user === meId);
  const list = data.notifications.filter((n) => (filter === 'all' || !n.read_at) && (type === 'all' || n.type === type));
  const unread = data.notifications.filter((n) => !n.read_at);

  const markAll = () => run(async () => {
    const now = new Date().toISOString();
    for (const n of unread) await backend.update('notifications', n.id, { read_at: now });
  }, { success: 'Tout est marqué comme lu', tables: ['notifications'], key: 'readall' });

  return (
    <>
      <div className="page-head">
        <div className="grow"><h2>Notifications</h2><p>Les notifications informent seulement : elles ne modifient aucune donnée.</p></div>
        <button className="btn" onClick={markAll} disabled={!unread.length}><Icon name="check" />Tout marquer comme lu</button>
      </div>

      {(swapsIn.length > 0 || swapsOut.length > 0) && (
        <div className="card">
          <div className="card-head"><h3>Demandes d’échange en attente</h3></div>
          <div className="list">
            {[...swapsIn, ...swapsOut].map((s) => {
              const o = data.task_occurrences.find((x) => x.id === s.occurrence_id);
              return (
                <div key={s.id} className="list-item">
                  <Icon name="swap" />
                  <div className="grow" style={{ cursor: 'pointer' }} onClick={() => o && openOccurrence(o.id)}>
                    <div className="title">{o?.name} · {o && fmtDate(o.due_date)}</div>
                    <div className="meta">{s.to_user === meId ? `${name(s.from_user)} vous demande de la reprendre` : `En attente de la réponse de ${name(s.to_user)}`}{s.message && ` · « ${s.message} »`}</div>
                  </div>
                  <SwapActions swapId={s.id} />
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="row-wrap">
        <Seg value={filter} onChange={setFilter} options={[{ value: 'unread', label: `Non lues (${unread.length})` }, { value: 'all', label: 'Toutes' }]} />
        <select className="select" style={{ width: 'auto' }} value={type} onChange={(e) => setType(e.target.value)} aria-label="Catégorie">
          <option value="all">Toutes catégories</option>
          {Object.entries(NOTIF_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>
      <div className="card">
        <div className="list">
          {list.length === 0 && <Empty icon="bell">{filter === 'unread' ? 'Aucune notification non lue.' : 'Aucune notification.'}</Empty>}
          {list.map((n) => (
            <div key={n.id} className={cx('list-item clickable', n.read_at && 'is-done')} onClick={() => {
              if (!n.read_at) run(() => backend.update('notifications', n.id, { read_at: new Date().toISOString() }), { tables: ['notifications'] });
              if (n.link) nav(n.link);
            }}>
              <Icon name={ICONS[n.type] ?? 'bell'} />
              <div className="grow">
                <div className="title" style={{ textDecoration: 'none' }}>{n.title}</div>
                <div className="meta">{n.body && <span>{n.body}</span>}<span>{fmtDateTime(n.created_at)}</span></div>
              </div>
              {!n.read_at && (
                <button className="btn btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); run(() => backend.update('notifications', n.id, { read_at: new Date().toISOString() }), { tables: ['notifications'] }); }}>Marquer lue</button>
              )}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
