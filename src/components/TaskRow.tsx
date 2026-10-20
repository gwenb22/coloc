import type { ReactNode } from 'react';
import { backend } from '../backend';
import { useData, useToasts } from '../store';
import type { Occurrence } from '../types';
import { Avatar, Icon, Person, StatusBadge } from './ui';
import { useModals } from './Modals';
import { MRow } from './mobile';
import { isOpen } from '../lib/fairness';
import { fmtDate, relativeDay } from '../lib/dates';
import { cx, errorMessage, fmtMinutes } from '../lib/util';

/** Cocher / décocher une tâche en un geste, avec « Annuler » dans la notification. */
export function useToggleDone(o: Occurrence) {
  const { meId, online, reload } = useData();
  const { push } = useToasts();
  return async () => {
    if (!online && backend.mode === 'supabase') return push({ text: 'Hors ligne : les modifications nécessitent une connexion.', kind: 'error' });
    try {
      if (o.status === 'done') {
        await backend.update('task_occurrences', o.id, { status: 'todo', done_at: null, done_by: null }, o.version);
        push({ text: 'Tâche rouverte', kind: 'info' });
      } else {
        const r = await backend.update<Occurrence>('task_occurrences', o.id, { status: 'done', done_at: new Date().toISOString(), done_by: meId }, o.version);
        push({
          text: `« ${o.name} » terminée`, kind: 'success',
          action: { label: 'Annuler', run: () => backend.update('task_occurrences', o.id, { status: o.status, done_at: null, done_by: null }, r.version).then(reload, (er) => push({ text: errorMessage(er), kind: 'error' })) },
        });
      }
      reload();
    } catch (er) {
      push({ text: errorMessage(er), kind: 'error' });
      reload();
    }
  };
}

const toneOf = (position: number | undefined) => `tone-${Math.max(0, (position ?? 1) - 1) % 6}`;

/** Ligne de tâche : liste classique, ou carte pastel (option dépliée) comme dans la maquette. */
export function TaskRow({ o, late, showDate = true, showPerson = true, card = false, expanded = false }: {
  o: Occurrence; late: boolean; showDate?: boolean; showPerson?: boolean; card?: boolean; expanded?: boolean;
}) {
  const { zone, data, name } = useData();
  const { openOccurrence } = useModals();
  const toggle = useToggleDone(o);
  const z = zone(o.zone_id);
  const done = o.status === 'done';
  const pendingSwap = data.swap_requests.some((s) => s.occurrence_id === o.id && s.status === 'pending');
  const canCheck = (isOpen(o) || done) && !o.proposed;
  const checkBox = canCheck ? (
    <button className={cx('check', done && 'done')} onClick={(e) => { e.stopPropagation(); toggle(); }} aria-label={done ? `Rouvrir ${o.name}` : `Marquer ${o.name} comme terminée`} title={done ? 'Rouvrir' : 'Terminer'}>
      <Icon name="check" size={16} />
    </button>
  ) : <span style={{ width: 28 }} />;

  const meta = (
    <div className="meta">
      {z && <span>{card ? z.name : `${z.icon} ${z.name}`}</span>}
      {showDate && <span className={late ? 'danger-text strong' : ''}>{relativeDay(o.due_date)}</span>}
      <span>{fmtMinutes(o.estimated_min)}</span>
      {o.locked && <Icon name="lock" size={12} />}
      {pendingSwap && <span className="badge warning"><Icon name="swap" size={11} />échange</span>}
      {o.problem && <span className="badge danger">problème</span>}
    </div>
  );
  const open = () => openOccurrence(o.id);
  const cls = cx('list-item clickable', done && 'is-done', late && 'is-late', o.proposed && 'is-proposed', card && `task-card ${toneOf(z?.position)}`, expanded && 'expanded');

  if (card && expanded) {
    const tpl = data.task_templates.find((t) => t.id === o.template_id);
    const desc = tpl?.instructions || tpl?.description;
    return (
      <div className={cls} onClick={open} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && open()}>
        <div className="xtop">
          <span className="zone-ic" aria-hidden="true">{z?.icon ?? '🏠'}</span>
          <div className="grow stack-sm" style={{ gap: 2 }}>
            <div className="title ellipsis">{o.name}</div>
            {meta}
          </div>
          {checkBox}
        </div>
        {desc && <p className="xdesc">{desc}</p>}
        <div className="xfoot">
          <span className="pill white sm">{late ? `prévue ${relativeDay(o.due_date)}` : fmtDate(o.due_date, { day: 'numeric', month: 'short' })}</span>
          {o.assigned_to && <span className="who-pill">{name(o.assigned_to)} <Avatar id={o.assigned_to} /></span>}
        </div>
      </div>
    );
  }

  return (
    <div className={cls} onClick={open} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && open()}>
      {card && <span className="zone-ic" aria-hidden="true">{z?.icon ?? '🏠'}</span>}
      {!card && checkBox}
      <div className="grow stack-sm" style={{ gap: 2 }}>
        <div className="title ellipsis">{o.name}</div>
        {meta}
      </div>
      {showPerson && <Person id={o.assigned_to} you={false} />}
      {(o.status !== 'todo' || late || o.proposed) && <span className="hide-sm"><StatusBadge status={o.status} late={late} proposed={o.proposed} /></span>}
      {card && checkBox}
    </div>
  );
}

/** Tâche affichée comme ligne simple dans une carte beige (surtitre + titre + case). */
export function TaskMRow({ o, late, over, showPerson }: { o: Occurrence; late?: boolean; over?: ReactNode; showPerson?: boolean }) {
  const { zone } = useData();
  const { openOccurrence } = useModals();
  const toggle = useToggleDone(o);
  const z = zone(o.zone_id);
  const done = o.status === 'done';
  return (
    <MRow
      over={over ?? <>{late ? `En retard · ${relativeDay(o.due_date)} · ` : ''}{z?.name ?? 'Sans zone'} · {fmtMinutes(o.estimated_min)}{o.effort === 'heavy' ? ' · effort important' : ''}</>}
      title={<>{z?.icon ? `${z.icon} ` : ''}{o.name}</>}
      done={done}
      late={late}
      onClick={() => openOccurrence(o.id)}
      right={<>
        {o.proposed && <span className="badge accent">proposée</span>}
        {showPerson && o.assigned_to && <Avatar id={o.assigned_to} />}
      </>}
      check={(isOpen(o) || done) && !o.proposed ? { done, onToggle: toggle, label: done ? `Rouvrir ${o.name}` : `Terminer ${o.name}` } : undefined}
    />
  );
}
