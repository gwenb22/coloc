import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { backend } from '../backend';
import { useData } from '../store';
import type { ISODate, UiPrefs, UUID } from '../types';
import { Empty, Icon } from '../components/ui';
import { useModals } from '../components/Modals';
import { TaskMRow, TaskRow } from '../components/TaskRow';
import { Beige, DayChip, MRow, type Tone } from '../components/mobile';
import { PrivateTaskModal } from '../components/Bedroom';
import type { PrivateTask } from '../types';
import { addDays, addMonths, endOfMonth, fmtDate, fmtDateLong, MONTHS, range, startOfMonth, startOfWeek, today, WEEKDAYS_SHORT } from '../lib/dates';
import { isOpen, makeIsLate } from '../lib/fairness';
import { templateDates } from '../lib/recurrence';
import { formatMoney } from '../lib/money';
import { cx } from '../lib/util';

type View = NonNullable<UiPrefs['calendar_view']>;
interface Ev {
  key: string;
  date: ISODate;
  label: string;
  cls: string;
  onClick: () => void;
  sort: number;
}

export default function CalendarPage() {
  const { data, me, meId, memberIds, personClass, run, name, toast } = useData();
  const { openOccurrence, openExpense, openReimbursement, openTemplate } = useModals();
  const nav = useNavigate();
  const t = today();
  const [view, setViewState] = useState<View>(() => me?.ui_prefs?.calendar_view ?? 'month');
  const [cursor, setCursor] = useState(t);
  const [person, setPerson] = useState<UUID | 'all'>('all');
  const [zoneF, setZoneF] = useState<UUID | 'all'>('all');
  const [statusF, setStatusF] = useState<'all' | 'open' | 'done'>('all');
  const [showFilters, setShowFilters] = useState(false);
  const [show, setShow] = useState({ tasks: true, forecast: true, room: true, maintenance: true, reimb: true, expenses: !!me?.ui_prefs?.calendar_show_expenses });
  const [roomTask, setRoomTask] = useState<PrivateTask | null>(null);
  const isLate = makeIsLate(data.task_templates, t);

  const setView = (v: View) => {
    setViewState(v);
    if (me) backend.update('profiles', me.id, { ui_prefs: { ...me.ui_prefs, calendar_view: v } }).catch(() => undefined);
  };
  const toggle = (k: keyof typeof show) => {
    const next = { ...show, [k]: !show[k] };
    setShow(next);
    if (k === 'expenses' && me) run(() => backend.update('profiles', me.id, { ui_prefs: { ...me.ui_prefs, calendar_show_expenses: next.expenses } }), { tables: ['profiles'] });
  };

  // Période affichée
  const [from, to] = useMemo<[ISODate, ISODate]>(() => {
    if (view === 'month') return [startOfWeek(startOfMonth(cursor)), addDays(startOfWeek(endOfMonth(cursor)), 6)];
    if (view === 'week') return [startOfWeek(cursor), addDays(startOfWeek(cursor), 6)];
    if (view === 'day') return [cursor, cursor];
    return [t, addDays(t, 30)];
  }, [view, cursor, t]);

  const events = useMemo(() => {
    const out: Ev[] = [];
    const occKeys = new Set(data.task_occurrences.map((o) => `${o.template_id}|${o.scheduled_date}`));
    if (show.tasks) {
      for (const o of data.task_occurrences) {
        if (o.due_date < from || o.due_date > to) continue;
        if (person !== 'all' && o.assigned_to !== person) continue;
        if (zoneF !== 'all' && o.zone_id !== zoneF) continue;
        if (statusF === 'open' && !isOpen(o)) continue;
        if (statusF === 'done' && o.status !== 'done') continue;
        out.push({
          key: o.id, date: o.due_date, label: (o.proposed ? '✦ ' : '') + o.name,
          cls: cx(personClass(o.assigned_to), o.status === 'done' && 'done', o.status === 'cancelled' && 'cancelled', isLate(o) && 'late'),
          onClick: () => openOccurrence(o.id), sort: o.status === 'done' ? 2 : 1,
        });
      }
    }
    if (show.forecast && statusF !== 'done') {
      const start = from > t ? from : addDays(t, 1);
      for (const tp of data.task_templates) {
        if (zoneF !== 'all' && tp.zone_id !== zoneF) continue;
        if (person !== 'all' && tp.fixed_user !== person) continue;
        for (const d of start <= to ? templateDates(tp, start, to) : []) {
          if (occKeys.has(`${tp.id}|${d}`)) continue;
          out.push({ key: `v-${tp.id}-${d}`, date: d, label: tp.name, cls: cx('virtual', tp.fixed_user && personClass(tp.fixed_user)), sort: 3,
            onClick: () => toast('Tâche non encore planifiée : générez la répartition de cette semaine dans Tâches > Répartition équitable.', 'info') });
        }
      }
    }
    // Ma chambre : uniquement les tâches de la personne connectée (privées)
    if (show.room) {
      for (const x of data.private_tasks ?? []) {
        if (x.done || !x.due_date || x.due_date < from || x.due_date > to) continue;
        out.push({ key: 'priv-' + x.id, date: x.due_date, label: '🔒 ' + x.title, cls: cx('private', x.due_date < t && 'late'), sort: 1, onClick: () => setRoomTask(x) });
      }
    }
    if (show.maintenance) {
      for (const m of data.maintenance) {
        if (!m.due_date || m.due_date < from || m.due_date > to || m.status === 'abandoned') continue;
        if (person !== 'all' && m.owner !== person) continue;
        out.push({ key: m.id, date: m.due_date, label: '🔧 ' + m.title, cls: cx('maint', m.status === 'resolved' && 'done'), sort: 0, onClick: () => nav(`/entretien?id=${m.id}`) });
      }
    }
    if (show.reimb) {
      for (const r of data.reimbursements) {
        if (r.status !== 'planned' || r.date < from || r.date > to) continue;
        out.push({ key: r.id, date: r.date, label: `↔ ${name(r.from_user)} → ${name(r.to_user)} ${formatMoney(r.amount_cents, data.household.currency)}`, cls: 'money', sort: 0, onClick: () => openReimbursement(undefined, r) });
      }
    }
    if (show.expenses) {
      for (const e of data.expenses) {
        if (e.status === 'cancelled' || e.date < from || e.date > to) continue;
        if (person !== 'all' && e.paid_by !== person) continue;
        out.push({ key: e.id, date: e.date, label: `€ ${e.title} ${formatMoney(e.amount_cents, data.household.currency)}`, cls: 'money', sort: 4, onClick: () => openExpense(e) });
      }
    }
    return out.sort((a, b) => a.sort - b.sort || a.label.localeCompare(b.label));
  }, [data, from, to, show, person, zoneF, statusF, t, personClass, isLate, openOccurrence, openExpense, openReimbursement, nav, name, toast]);

  const byDate = useMemo(() => {
    const m = new Map<ISODate, Ev[]>();
    for (const e of events) m.set(e.date, [...(m.get(e.date) ?? []), e]);
    return m;
  }, [events]);
  const lateCount = data.task_occurrences.filter((o) => isLate(o) && (person === 'all' || o.assigned_to === person)).length;

  const move = (dir: number) => setCursor(view === 'month' ? addMonths(cursor, dir) : view === 'week' ? addDays(cursor, 7 * dir) : addDays(cursor, dir));
  const title = view === 'month' ? `${MONTHS[Number(cursor.slice(5, 7)) - 1]} ${cursor.slice(0, 4)}`
    : view === 'week' ? `Semaine du ${fmtDate(from, { day: 'numeric', month: 'long' })}`
    : view === 'day' ? fmtDateLong(cursor) : '30 prochains jours';

  const monthTitle = view === 'month' ? MONTHS[Number(cursor.slice(5, 7)) - 1].replace(/^./, (c) => c.toUpperCase()) + (cursor.slice(0, 4) !== t.slice(0, 4) ? ` ${cursor.slice(0, 4)}` : '') : title;
  const toneOfDay = (d: ISODate): Tone => {
    const os = data.task_occurrences.filter((o) => o.due_date === d && !o.proposed && o.status !== 'cancelled' && (zoneF === 'all' || o.zone_id === zoneF) && (person === 'all' || o.assigned_to === person));
    // Couleur de la personne qui porte l'essentiel de la charge du jour ; bleu si elle est partagée
    const load: Record<string, number> = {};
    for (const o of os) if (o.assigned_to) load[o.assigned_to] = (load[o.assigned_to] ?? 0) + Number(o.weight);
    const total = Object.values(load).reduce((x, y) => x + y, 0);
    if (!total) return 'none';
    const [top, w] = Object.entries(load).sort((x, y) => y[1] - x[1])[0];
    if (w / total < 0.65) return 'bleu';
    return personClass(top) === 'p-a' ? 'rose' : 'vert';
  };
  const lateOn = (d: ISODate) => data.task_occurrences.some((o) => o.due_date === d && isLate(o) && (person === 'all' || o.assigned_to === person));

  return (
    <div className="mpage">
      {roomTask && <PrivateTaskModal task={roomTask} onClose={() => setRoomTask(null)} />}
      <div className="sec-title">
        <h2 style={{ fontSize: 26 }}>{monthTitle}</h2>
        <div className="sec-right">
          <select className="pill dark sm" value={view} onChange={(e) => setView(e.target.value as View)} aria-label="Vue">
            <option value="month">mois</option><option value="week">semaine</option><option value="day">jour</option><option value="upcoming">échéances</option>
          </select>
        </div>
      </div>
      <div className="row-wrap">
        {view !== 'upcoming' && <>
          <button className="round-btn" onClick={() => move(-1)} aria-label="Période précédente"><Icon name="chevronLeft" size={18} /></button>
          <button className="round-btn" onClick={() => move(1)} aria-label="Période suivante"><Icon name="chevronRight" size={18} /></button>
          <button className="pill sm" onClick={() => setCursor(t)}>Aujourd’hui</button>
        </>}
        <button className="pill sm" aria-pressed={showFilters} onClick={() => setShowFilters(!showFilters)}><Icon name="list" size={14} />Filtres</button>
        {lateCount > 0 && show.tasks && <button className="pill sm" style={{ color: '#c0262d', background: 'var(--danger-soft)' }} onClick={() => { setView('day'); setCursor(t); }}><Icon name="alert" size={14} />{lateCount} en retard</button>}
      </div>
      {showFilters && (
        <Beige>
          <div className="filters" style={{ paddingBottom: 10 }}>
            <button className="chip" aria-pressed={show.tasks} onClick={() => toggle('tasks')}>Tâches</button>
            <button className="chip" aria-pressed={show.forecast} onClick={() => toggle('forecast')}>Prévisions</button>
            <button className="chip" aria-pressed={show.maintenance} onClick={() => toggle('maintenance')}>Entretien</button>
            <button className="chip" aria-pressed={show.reimb} onClick={() => toggle('reimb')}>Remboursements</button>
            <button className="chip" aria-pressed={show.expenses} onClick={() => toggle('expenses')}>Dépenses</button>
            <button className="chip" aria-pressed={show.room} onClick={() => toggle('room')}>Ma chambre 🔒</button>
            <select className="select" value={person} onChange={(e) => setPerson(e.target.value as UUID)} aria-label="Colocataire">
              <option value="all">Tout le monde</option>
              {data.members.map((m) => <option key={m.user_id} value={m.user_id}>{name(m.user_id)}{m.user_id === meId ? ' (vous)' : ''}</option>)}
            </select>
            <select className="select" value={zoneF} onChange={(e) => setZoneF(e.target.value as UUID)} aria-label="Zone">
              <option value="all">Toutes les zones</option>
              {data.zones.filter((z) => z.active).map((z) => <option key={z.id} value={z.id}>{z.icon} {z.name}</option>)}
            </select>
            <select className="select" value={statusF} onChange={(e) => setStatusF(e.target.value as typeof statusF)} aria-label="Statut">
              <option value="all">Tous statuts</option><option value="open">À faire</option><option value="done">Terminées</option>
            </select>
          </div>
        </Beige>
      )}

      {view === 'month' && (
        <div className="mgrid">
          <div className="mcol">
            <div className="month">
              {WEEKDAYS_SHORT.map((d) => <div key={d} className="dl">{d.replace(/^./, (c) => c.toUpperCase())}</div>)}
              {range(from, to).map((d) => d.slice(0, 7) !== cursor.slice(0, 7)
                ? <span key={d} className="daychip blank" />
                : <DayChip key={d} label={Number(d.slice(8))} tone={toneOfDay(d)} today={d === t} selected={d === cursor} late={lateOn(d)} onClick={() => setCursor(d)} title={fmtDateLong(d)} />)}
            </div>
            <div className="legend-dots">
              {memberIds.map((m, i) => <span key={m}><i className={i === 0 ? 't-rose' : 't-vert'} />{name(m)}</span>)}
              <span><i className="t-bleu" />Partagé</span>
              <span><i style={{ background: 'var(--surface-3)' }} />Rien de prévu</span>
            </div>
          </div>
          <div className="mcol">
            <Beige title={fmtDate(cursor, { weekday: 'long', day: 'numeric' }).replace(/^./, (c) => c.toUpperCase())}
              action={<button className="pill dark sm" onClick={() => openTemplate(null, { frequency: 'once', once_date: cursor })}>Ajouter</button>}>
              <DayRows date={cursor} events={byDate.get(cursor) ?? []} showLate={cursor === t && show.tasks} person={person} />
            </Beige>
          </div>
        </div>
      )}

      {view === 'week' && (
        <div className="cal-week">
          {range(from, to).map((d) => {
            const evs = byDate.get(d) ?? [];
            return (
              <div key={d} className={cx('wcol', d === t && 'today')}>
                <h4 style={{ cursor: 'pointer' }} onClick={() => { setCursor(d); setView('day'); }}>{fmtDate(d, { weekday: 'short', day: 'numeric' })}</h4>
                {evs.length === 0 && <span className="xs muted">—</span>}
                {evs.map((e) => <button key={e.key} className={cx('ev', e.cls)} onClick={e.onClick} title={e.label} style={{ whiteSpace: 'normal' }}>{e.label}</button>)}
              </div>
            );
          })}
        </div>
      )}

      {view === 'day' && (
        <div className="card">
          <div className="card-head">
            <h3>{fmtDateLong(cursor)}</h3>
            <button className="btn btn-sm" onClick={() => openTemplate(null, { frequency: 'once', once_date: cursor })}><Icon name="plus" size={14} />Tâche ponctuelle</button>
          </div>
          <DayList date={cursor} events={byDate.get(cursor) ?? []} showLate={cursor === t && show.tasks} person={person} />
        </div>
      )}

      {view === 'upcoming' && (
        <div className="card">
          {lateCount > 0 && show.tasks && <DayList date={t} events={[]} showLate person={person} onlyLate />}
          {range(from, to).filter((d) => (byDate.get(d) ?? []).length).map((d) => (
            <div key={d}>
              <div className="list-group-title">{fmtDateLong(d)}{d === t && ' · aujourd’hui'}</div>
              <DayList date={d} events={byDate.get(d) ?? []} person={person} />
            </div>
          ))}
          {events.length === 0 && <Empty icon="calendar">Rien de prévu.</Empty>}
        </div>
      )}

      {view !== 'month' && <div className="legend">
        {memberIds.map((m, i) => <span key={m}><i className={i === 0 ? 'bar-a' : 'bar-b'} />{name(m)}</span>)}
        <span><i style={{ background: 'var(--vert)' }} />Argent</span>
        <span><i style={{ background: 'var(--jaune)' }} />Entretien</span>
        <span><i style={{ border: '1px dashed var(--border-strong)' }} />Prévision non planifiée</span>
        <span>✦ proposée</span>
      </div>}
    </div>
  );
}

function DayList({ date, events, showLate, person, onlyLate }: { date: ISODate; events: Ev[]; showLate?: boolean; person: UUID | 'all'; onlyLate?: boolean }) {
  const { data } = useData();
  const t = today();
  const isLate = makeIsLate(data.task_templates, t);
  const occById = new Map(data.task_occurrences.map((o) => [o.id, o]));
  const late = showLate ? data.task_occurrences.filter((o) => isLate(o) && o.due_date !== date && (person === 'all' || o.assigned_to === person)) : [];
  const occs = events.map((e) => occById.get(e.key)).filter(Boolean);
  const others = events.filter((e) => !occById.has(e.key));
  return (
    <div className="list">
      {late.length > 0 && <div className="list-group-title" style={{ color: 'var(--danger)' }}>En retard · {late.length}</div>}
      {late.map((o) => <TaskRow key={o.id} o={o} late />)}
      {!onlyLate && occs.map((o) => <TaskRow key={o!.id} o={o!} late={isLate(o!)} showDate={false} />)}
      {!onlyLate && others.map((e) => (
        <div key={e.key} className="list-item clickable" onClick={e.onClick}>
          <span className={cx('ev', e.cls)} style={{ width: 'auto', flex: 1, fontSize: 14, padding: '6px 10px' }}>{e.label}</span>
        </div>
      ))}
      {!onlyLate && !late.length && !events.length && <Empty icon="calendar">Rien ce jour-là.</Empty>}
    </div>
  );
}

function DayRows({ date, events, showLate, person }: { date: ISODate; events: Ev[]; showLate?: boolean; person: UUID | 'all' }) {
  const { data } = useData();
  const t = today();
  const isLate = makeIsLate(data.task_templates, t);
  const occById = new Map(data.task_occurrences.map((o) => [o.id, o]));
  const late = showLate ? data.task_occurrences.filter((o) => isLate(o) && o.due_date !== date && (person === 'all' || o.assigned_to === person)) : [];
  const occs = events.map((e) => occById.get(e.key)).filter((o): o is NonNullable<typeof o> => !!o);
  const others = events.filter((e) => !occById.has(e.key));
  if (!late.length && !events.length) return <div className="empty-line">Rien ce jour-là.</div>;
  return (
    <>
      {late.map((o) => <TaskMRow key={o.id} o={o} late showPerson />)}
      {occs.map((o) => <TaskMRow key={o.id} o={o} late={isLate(o)} showPerson />)}
      {others.map((e) => <MRow key={e.key} over={e.cls.includes('private') ? 'Ma chambre · privé' : e.cls.includes('virtual') ? 'Prévision · pas encore planifiée' : e.cls.includes('maint') ? 'Entretien' : 'Argent'} title={e.label} onClick={e.onClick} />)}
    </>
  );
}
