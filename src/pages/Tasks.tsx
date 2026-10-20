import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { backend } from '../backend';
import { useData } from '../store';
import type { Occurrence, OccStatus, TaskTemplate, UUID } from '../types';
import { Empty, Icon, Person, PersonSelect, Seg, StatusBadge, STATUS_LABEL, Tabs, useConfirm } from '../components/ui';
import { useModals } from '../components/Modals';
import { TaskMRow, TaskRow } from '../components/TaskRow';
import { Beige, Columns, DayChip, SectionTitle } from '../components/mobile';
import { addDays, fmtDate, fmtDateLong, startOfWeek, today, toISO } from '../lib/dates';
import { coefs, EFFORT_LABEL, fairnessStats, isOpen, makeIsLate, occurrenceFields, planAssignments, weeklyEvolution, weightOf } from '../lib/fairness';
import { describeFrequency, templateDates } from '../lib/recurrence';
import { centsCSV, download, toCSV } from '../lib/csv';
import { cx, fmtMinutes, plural } from '../lib/util';

type Tab = 'semaine' | 'repartition' | 'planning' | 'catalogue' | 'historique';

export default function Tasks() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'semaine';
  const go = (t: Tab, extra: Record<string, string> = {}) => setParams(t === 'semaine' ? extra : { tab: t, ...extra }, { replace: true });
  return (
    <div className="mpage">
      <Tabs value={tab} onChange={(t) => go(t)} tabs={[
        { value: 'semaine', label: 'Semaine' }, { value: 'repartition', label: 'Répartition' }, { value: 'planning', label: 'Liste' },
        { value: 'catalogue', label: 'Catalogue' }, { value: 'historique', label: 'Historique' },
      ]} />
      {tab === 'semaine' && <Week onPlan={(w) => go('repartition', { week: w })} />}
      {tab === 'repartition' && <Repartition initialWeek={params.get('week') ?? undefined} />}
      {tab === 'planning' && <Planning />}
      {tab === 'catalogue' && <Catalogue />}
      {tab === 'historique' && <History />}
    </div>
  );
}

// =====================================================================
// Semaine (vue de la maquette) : jours, équilibre, tâches du jour choisi
// =====================================================================
function Week({ onPlan }: { onPlan: (weekStart: string) => void }) {
  const { data, meId, memberIds, name } = useData();
  const { openTemplate } = useModals();
  const t = today();
  const isLate = makeIsLate(data.task_templates, t);
  const [ws, setWs] = useState(startOfWeek(t));
  const [sel, setSel] = useState(t);
  const [who, setWho] = useState<'me' | 'all'>('me');
  const days = Array.from({ length: 7 }, (_, i) => addDays(ws, i));
  const mine = (o: Occurrence) => who === 'all' || o.assigned_to === meId;
  const live = data.task_occurrences.filter((o) => o.status !== 'cancelled');
  const ofDay = (d: string) => live.filter((o) => o.due_date === d && mine(o));
  const templates = data.task_templates.filter((tp) => tp.active && !tp.archived);
  const expected = templates.reduce((a, tp) => a + templateDates(tp, ws, addDays(ws, 6)).length, 0);
  const weekOccs = live.filter((o) => o.due_date >= ws && o.due_date <= addDays(ws, 6));
  const proposed = weekOccs.filter((o) => o.proposed).length;
  const st = fairnessStats(weekOccs.map((o) => ({ ...o, proposed: false })), memberIds, ws, addDays(ws, 6));
  const [a, b] = memberIds;
  const pa = st.per[a]?.weighted ?? 0, pb = b ? st.per[b]?.weighted ?? 0 : 0;
  const max = Math.max(1, pa, pb);

  const tone = (d: string) => {
    const os = ofDay(d).filter((o) => !o.proposed);
    if (os.length && os.every((o) => o.status === 'done')) return 'jaune' as const;
    return 'none' as const;
  };
  const selList = [
    ...(sel === t ? live.filter((o) => isLate(o) && mine(o) && o.due_date < t) : []),
    ...ofDay(sel),
  ].sort((x, y) => Number(x.status === 'done') - Number(y.status === 'done') || Number(y.weight) - Number(x.weight));
  const selLabel = fmtDate(sel, { weekday: 'long', day: 'numeric' }).replace(/^./, (c) => c.toUpperCase());

  return (
    <>
      <div className="week-nav">
        <button className="round-btn" onClick={() => { setWs(addDays(ws, -7)); setSel(addDays(sel, -7)); }} aria-label="Semaine précédente"><Icon name="chevronLeft" size={18} /></button>
        <div className="grow">Semaine du {fmtDate(ws, { day: 'numeric', month: 'long' })}</div>
        <button className="round-btn" onClick={() => { setWs(addDays(ws, 7)); setSel(addDays(sel, 7)); }} aria-label="Semaine suivante"><Icon name="chevronRight" size={18} /></button>
      </div>
      <div className="week">
        {days.map((d, i) => <div key={d} className={cx('dl', d === t && 'today')}>{['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'][i]}</div>)}
        {days.map((d) => (
          <DayChip key={d} label={Number(d.slice(8))} tone={d === sel && d !== t ? 'rose' : tone(d)} today={d === t} selected={d === sel}
            late={ofDay(d).some((o) => isLate(o))} onClick={() => setSel(d)} title={fmtDateLong(d)} />
        ))}
      </div>

      <div className="mgrid">
        <div className="mcol">
          <SectionTitle title="Équilibre" right={<span className="muted">{weekOccs.length}/{expected} planifiées</span>} />
          <Columns items={[
            { label: name(a), value: `${Math.round(pa)} pts`, tone: 'rose', ratio: pa / max },
            ...(b ? [{ label: name(b), value: `${Math.round(pb)} pts`, tone: 'vert' as const, ratio: pb / max }] : []),
            { label: 'Écart', value: `${Math.round(st.gap)} pts`, tone: 'bleu', ratio: st.gap / max },
          ]} />
          {proposed > 0 && (
            <button className="soft-card t-lilas" style={{ border: 0, cursor: 'pointer', textAlign: 'left', font: 'inherit' }} onClick={() => onPlan(ws)}>
              <Icon name="sparkles" />
              <div className="grow"><b>{plural(proposed, 'tâche proposée', 'tâches proposées')}</b> <span className="muted">à vérifier puis confirmer</span></div>
              <Icon name="arrowRight" />
            </button>
          )}
        </div>
        <div className="mcol">
          <Beige title={selLabel} action={<Seg value={who} onChange={setWho} options={[{ value: 'me', label: 'Moi' }, { value: 'all', label: 'Tous' }]} />}>
            {selList.length === 0 && <div className="empty-line">{weekOccs.length ? 'Aucune tâche ce jour-là.' : 'Semaine pas encore planifiée.'}</div>}
            {selList.map((o) => <TaskMRow key={o.id} o={o} late={isLate(o)} showPerson={who === 'all'} />)}
          </Beige>
          {weekOccs.length < expected || proposed > 0 ? (
            <button className="btn btn-primary btn-big" onClick={() => onPlan(ws)}><Icon name="sparkles" />Générer la répartition</button>
          ) : (
            <button className="btn btn-primary btn-big" onClick={() => openTemplate(null, { frequency: 'once', once_date: sel })}><Icon name="plus" />Ajouter une tâche</button>
          )}
        </div>
      </div>
    </>
  );
}

// =====================================================================
// Planning
// =====================================================================
function Planning() {
  const { data, meId } = useData();
  const t = today();
  const isLate = makeIsLate(data.task_templates, t);
  const [range, setRange] = useState<'week' | 'next' | 'month' | 'late'>('week');
  const [person, setPerson] = useState<UUID | 'all'>('all');
  const [zone, setZone] = useState<UUID | 'all'>('all');
  const [status, setStatus] = useState<'open' | 'all' | OccStatus>('open');

  const ws = startOfWeek(t);
  const [from, to] = range === 'week' ? [ws, addDays(ws, 6)] : range === 'next' ? [addDays(ws, 7), addDays(ws, 13)] : range === 'month' ? [t, addDays(t, 30)] : ['0000-01-01', t];

  const list = data.task_occurrences
    .filter((o) => (range === 'late' ? isLate(o) : (o.due_date >= from && o.due_date <= to) || (range === 'week' && isLate(o))))
    .filter((o) => person === 'all' || o.assigned_to === person)
    .filter((o) => zone === 'all' || o.zone_id === zone)
    .filter((o) => (status === 'all' ? true : status === 'open' ? isOpen(o) : o.status === status))
    .sort((a, b) => a.due_date.localeCompare(b.due_date) || a.name.localeCompare(b.name));

  const groups = new Map<string, Occurrence[]>();
  for (const o of list) {
    const key = isLate(o) ? 'late' : o.due_date;
    groups.set(key, [...(groups.get(key) ?? []), o]);
  }
  const unplanned = range !== 'late' && !data.task_occurrences.some((o) => o.due_date >= from && o.due_date <= to) && data.task_templates.some((tp) => templateDates(tp, from, to).length > 0);

  return (
    <div className="card">
      <div className="card-head">
        <div className="filters grow">
          <Seg value={range} onChange={setRange} options={[{ value: 'week', label: 'Cette semaine' }, { value: 'next', label: 'Semaine proch.' }, { value: 'month', label: '30 jours' }, { value: 'late', label: 'En retard' }]} />
          <select className="select" value={person} onChange={(e) => setPerson(e.target.value as UUID)} aria-label="Personne">
            <option value="all">Tout le monde</option>
            {data.members.map((m) => <option key={m.user_id} value={m.user_id}>{data.profiles.find((p) => p.id === m.user_id)?.display_name}{m.user_id === meId ? ' (vous)' : ''}</option>)}
          </select>
          <select className="select" value={zone} onChange={(e) => setZone(e.target.value as UUID)} aria-label="Zone">
            <option value="all">Toutes les zones</option>
            {data.zones.filter((z) => z.active).sort((a, b) => a.position - b.position).map((z) => <option key={z.id} value={z.id}>{z.icon} {z.name}</option>)}
          </select>
          <select className="select" value={status} onChange={(e) => setStatus(e.target.value as OccStatus)} aria-label="Statut">
            <option value="open">Non terminées</option>
            <option value="all">Tous les statuts</option>
            {(Object.keys(STATUS_LABEL) as OccStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
          </select>
        </div>
      </div>
      {unplanned && (
        <div className="info-box" style={{ margin: 14 }}>Cette période n’est pas encore planifiée. Ouvrez l’onglet <b>Répartition équitable</b> pour générer une proposition.</div>
      )}
      <div className="list">
        {list.length === 0 && !unplanned && <Empty icon="check">Aucune tâche pour ces filtres.</Empty>}
        {[...groups.entries()].map(([k, os]) => (
          <div key={k}>
            <div className="list-group-title" style={k === 'late' ? { color: 'var(--danger)' } : undefined}>
              {k === 'late' ? `En retard · ${os.length}` : `${fmtDateLong(k)}${k === t ? ' · aujourd’hui' : ''}`}
            </div>
            {os.map((o) => <TaskRow key={o.id} o={o} late={isLate(o)} showDate={k === 'late'} />)}
          </div>
        ))}
      </div>
    </div>
  );
}

// =====================================================================
// Répartition équitable
// =====================================================================
function Repartition({ initialWeek }: { initialWeek?: string }) {
  const { data, run, memberIds, meId, name, zone } = useData();
  const confirm = useConfirm();
  const { openOccurrence } = useModals();
  const t = today();
  const hasThisWeek = data.task_occurrences.some((o) => o.due_date >= startOfWeek(t) && o.due_date <= addDays(startOfWeek(t), 6));
  const [ws, setWs] = useState(() => initialWeek ?? (hasThisWeek ? addDays(startOfWeek(t), 7) : startOfWeek(t)));
  const we = addDays(ws, 6);
  const [recompute, setRecompute] = useState(false);
  const [statsPeriod, setStatsPeriod] = useState<'week' | '4w' | '12w'>('4w');
  const settings = data.household.settings;
  const c = coefs(settings);

  const templates = data.task_templates.filter((tp) => tp.active && !tp.archived);
  const weekOccs = data.task_occurrences.filter((o) => o.due_date >= ws && o.due_date <= we);
  const proposed = weekOccs.filter((o) => o.proposed && o.status !== 'cancelled');
  const expectedSlots = templates.reduce((a, tp) => a + templateDates(tp, ws, we).length, 0);
  const plannedCount = weekOccs.filter((o) => o.status !== 'cancelled').length;
  const weekStats = fairnessStats(data.task_occurrences.map((o) => ({ ...o, proposed: false })), memberIds, ws, we);

  const generate = async () => {
    const plan = planAssignments({ members: memberIds, templates, occurrences: data.task_occurrences, unavailabilities: data.unavailabilities, settings, start: ws, end: we, recomputeValidated: recompute });
    const toInsert: Partial<Occurrence>[] = [];
    const toUpdate: { o: Occurrence; patch: Partial<Occurrence> }[] = [];
    for (const s of plan.slots) {
      if (s.kept) continue;
      const tpl = templates.find((x) => x.id === s.template_id)!;
      if (!s.existing) toInsert.push(occurrenceFields(tpl, s.scheduled_date, s.assigned_to, weightOf(tpl.duration_min, tpl.effort, c), true));
      else if (s.existing.assigned_to !== s.assigned_to || (recompute && !s.existing.proposed)) toUpdate.push({ o: s.existing, patch: { assigned_to: s.assigned_to, proposed: true } });
    }
    if (!toInsert.length && !toUpdate.length) {
      return run(async () => undefined, { success: 'La répartition est déjà à jour pour cette semaine.' });
    }
    await run(async () => {
      if (toInsert.length) await backend.insert('task_occurrences', toInsert);
      for (const u of toUpdate) await backend.update('task_occurrences', u.o.id, u.patch);
    }, { success: `${plural(toInsert.length + toUpdate.length, 'tâche')} proposée${toInsert.length + toUpdate.length > 1 ? 's' : ''}. Vérifiez puis confirmez.`, tables: ['task_occurrences'], key: 'generate' });
  };

  const validate = () => run(async () => {
    for (const o of proposed) await backend.update('task_occurrences', o.id, { proposed: false });
  }, { success: 'Répartition confirmée', tables: ['task_occurrences'], key: 'validate' });

  const discard = async () => {
    if (!(await confirm({ title: 'Abandonner la proposition ?', message: 'Les tâches proposées non validées de cette semaine seront retirées.', confirm: 'Abandonner', danger: true }))) return;
    await run(async () => {
      for (const o of proposed) {
        if (data.task_occurrences.some((x) => x.id === o.id && x.status === 'todo')) await backend.remove('task_occurrences', o.id);
      }
    }, { success: 'Proposition abandonnée', tables: ['task_occurrences'] });
  };

  const assign = (o: Occurrence, v: UUID | null) => run(() => backend.update('task_occurrences', o.id, { assigned_to: v, locked: true }, o.version), { tables: ['task_occurrences'] });
  const toggleLock = (o: Occurrence) => run(() => backend.update('task_occurrences', o.id, { locked: !o.locked }, o.version), { tables: ['task_occurrences'] });

  const byDay = new Map<string, Occurrence[]>();
  for (const o of [...weekOccs].sort((a, b) => a.due_date.localeCompare(b.due_date) || Number(b.weight) - Number(a.weight))) byDay.set(o.due_date, [...(byDay.get(o.due_date) ?? []), o]);

  // Indicateurs
  const [sFrom, sTo] = statsPeriod === 'week' ? [startOfWeek(t), addDays(startOfWeek(t), 6)] : statsPeriod === '4w' ? [addDays(startOfWeek(t), -21), addDays(startOfWeek(t), 6)] : [addDays(startOfWeek(t), -77), addDays(startOfWeek(t), 6)];
  const st = fairnessStats(data.task_occurrences, memberIds, sFrom, sTo);
  const stDone = fairnessStats(data.task_occurrences, memberIds, sFrom, t, 'done');
  const evo = weeklyEvolution(data.task_occurrences, memberIds, t, statsPeriod === '12w' ? 12 : 4);
  const maxEvo = Math.max(1, ...evo.flatMap((w) => memberIds.map((m) => w.per[m])));

  return (
    <div className="stack">
      <div className="card">
        <div className="card-head">
          <div className="row grow" style={{ flexWrap: 'wrap' }}>
            <button className="btn btn-icon btn-sm" onClick={() => setWs(addDays(ws, -7))} aria-label="Semaine précédente"><Icon name="chevronLeft" /></button>
            <h2 style={{ flex: 'none' }}>Semaine du {fmtDate(ws, { day: 'numeric', month: 'long' })}</h2>
            <button className="btn btn-icon btn-sm" onClick={() => setWs(addDays(ws, 7))} aria-label="Semaine suivante"><Icon name="chevronRight" /></button>
            {ws !== startOfWeek(t) && <button className="btn btn-ghost btn-sm" onClick={() => setWs(startOfWeek(t))}>Cette semaine</button>}
          </div>
          <span className="small muted">{plannedCount}/{expectedSlots} planifiées · {proposed.length} à valider</span>
        </div>
        <div className="card-body stack">
          <div className="row-wrap">
            <button className="btn btn-primary" onClick={generate}><Icon name="sparkles" />{plannedCount ? 'Relancer la proposition' : 'Générer une proposition'}</button>
            {proposed.length > 0 && <button className="btn" onClick={validate}><Icon name="check" />Confirmer la répartition ({proposed.length})</button>}
            {proposed.length > 0 && <button className="btn btn-ghost" onClick={discard}>Abandonner</button>}
            <label className="toggle small"><input type="checkbox" checked={recompute} onChange={(e) => setRecompute(e.target.checked)} />Recalculer aussi les attributions déjà validées (sauf verrouillées et terminées)</label>
          </div>
          <p className="small muted">
            L’algorithme attribue chaque tâche à la personne disponible dont la charge pondérée (durée × effort) serait la plus faible, en tenant compte des tâches terminées sur les {settings.window_weeks ?? 4} dernières semaines,
            des préférences, des indisponibilités et en évitant les répétitions. Les attributions fixes, verrouillées ou modifiées à la main sont conservées.
          </p>
          {weekOccs.length > 0 && (
            <div className="grid grid-2">
              {memberIds.map((m, i) => {
                const p = weekStats.per[m];
                const total = weekStats.total || 1;
                return (
                  <div key={m} className="card card-pad stack-sm" style={{ background: 'var(--surface-2)' }}>
                    <div className="row between"><Person id={m} /><span className="num strong">{Math.round(p.weighted)} pts</span></div>
                    <div className="progress"><div className={i === 0 ? 'bar-a' : 'bar-b'} style={{ width: `${(p.weighted / total) * 100}%` }} /></div>
                    <span className="xs muted">{fmtMinutes(p.estimated_min)} estimées · {plural(p.count, 'tâche')}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        {weekOccs.length === 0 ? (
          <Empty icon="sparkles">Aucune tâche planifiée cette semaine. Générez une proposition pour commencer.</Empty>
        ) : (
          <div className="list">
            {[...byDay.entries()].map(([d, os]) => (
              <div key={d}>
                <div className="list-group-title">{fmtDateLong(d)}</div>
                {os.map((o) => (
                  <div key={o.id} className={cx('list-item', o.proposed && 'is-proposed', o.status === 'done' && 'is-done')}>
                    <div className="grow" style={{ cursor: 'pointer' }} onClick={() => openOccurrence(o.id)}>
                      <div className="title ellipsis">{o.name}</div>
                      <div className="meta">{zone(o.zone_id)?.icon} {zone(o.zone_id)?.name} · {fmtMinutes(o.estimated_min)} · {Number(o.weight)} pts</div>
                    </div>
                    {o.proposed ? <span className="badge accent hide-sm">Proposée</span> : <span className="hide-sm"><StatusBadge status={o.status} /></span>}
                    {isOpen(o) ? (
                      <>
                        <PersonSelect className="input-sm" value={o.assigned_to} allowNone onChange={(v) => assign(o, v)} />
                        <button className={cx('btn btn-sm btn-icon', o.locked ? '' : 'btn-ghost')} onClick={() => toggleLock(o)} aria-label={o.locked ? 'Déverrouiller' : 'Verrouiller'} title={o.locked ? 'Attribution verrouillée' : 'Verrouiller l’attribution'}>
                          <Icon name={o.locked ? 'lock' : 'unlock'} size={15} />
                        </button>
                      </>
                    ) : <Person id={o.done_by ?? o.assigned_to} />}
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Indicateurs d’équité</h2>
          <Seg value={statsPeriod} onChange={setStatsPeriod} options={[{ value: 'week', label: 'Semaine' }, { value: '4w', label: '4 semaines' }, { value: '12w', label: '12 semaines' }]} />
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th></th>{memberIds.map((m) => <th key={m}>{name(m)}</th>)}<th>Écart</th></tr>
            </thead>
            <tbody>
              <tr><td className="strong">Charge pondérée</td>{memberIds.map((m) => <td key={m} className="num strong">{Math.round(st.per[m].weighted)} pts</td>)}<td className="num">{Math.round(st.gap)} pts ({Math.round(st.gapPct)} %)</td></tr>
              <tr><td>Temps estimé attribué</td>{memberIds.map((m) => <td key={m} className="num">{fmtMinutes(st.per[m].estimated_min)}</td>)}<td className="num">{memberIds.length === 2 ? fmtMinutes(Math.abs(st.per[memberIds[0]].estimated_min - st.per[memberIds[1]].estimated_min)) : '—'}</td></tr>
              <tr><td>Charge réalisée (terminées)</td>{memberIds.map((m) => <td key={m} className="num">{Math.round(stDone.per[m].weighted)} pts</td>)}<td className="num">{Math.round(stDone.gap)} pts</td></tr>
              <tr><td>Temps réellement déclaré</td>{memberIds.map((m) => <td key={m} className="num">{st.per[m].actual_min ? fmtMinutes(st.per[m].actual_min) : '—'}</td>)}<td></td></tr>
              <tr><td className="muted">Tâches terminées / attribuées</td>{memberIds.map((m) => <td key={m} className="num muted">{st.per[m].done} / {st.per[m].count}</td>)}<td></td></tr>
            </tbody>
          </table>
        </div>
        <div className="card-body stack-sm">
          <h3>Évolution hebdomadaire de la charge</h3>
          <div className="bars" role="img" aria-label="Charge pondérée par semaine et par personne">
            {evo.map((w) => (
              <div key={w.week} className="col">
                <div className="pair">
                  {memberIds.map((m, i) => <div key={m} className={i === 0 ? 'bar-a' : 'bar-b'} style={{ height: `${(w.per[m] / maxEvo) * 100}%` }} title={`${name(m)} : ${Math.round(w.per[m])} pts`} />)}
                </div>
                <span className="xs muted nowrap">{fmtDate(w.week)}</span>
              </div>
            ))}
          </div>
          <div className="legend">{memberIds.map((m, i) => <span key={m}><i className={i === 0 ? 'bar-a' : 'bar-b'} />{name(m)}</span>)}</div>
          <p className="xs muted">Le nombre de tâches est un indicateur secondaire : cinq petites tâches ne représentent pas forcément autant de travail qu’une grande. Les tâches annulées ne sont jamais comptées.</p>
        </div>
      </div>

      <Unavailabilities />
      <span className="xs muted">Connecté·e : {name(meId)} · coefficients d’effort : léger {c.light}, modéré {c.moderate}, important {c.heavy} (modifiables dans Paramètres)</span>
    </div>
  );
}

function Unavailabilities() {
  const { data, run, meId, name } = useData();
  const confirm = useConfirm();
  const [start, setStart] = useState(today());
  const [end, setEnd] = useState(addDays(today(), 2));
  const [note, setNote] = useState('');
  const list = [...data.unavailabilities].filter((u) => u.end_date >= addDays(today(), -30)).sort((a, b) => a.start_date.localeCompare(b.start_date));
  return (
    <div className="card">
      <div className="card-head"><h2>Indisponibilités</h2><span className="small muted">Prises en compte par la répartition automatique</span></div>
      <div className="card-body">
        <form className="filters" onSubmit={async (e) => {
          e.preventDefault();
          if (end < start) return;
          const r = await run(() => backend.insert('unavailabilities', { household_id: data.household.id, user_id: meId, start_date: start, end_date: end, note: note.trim() }), { success: 'Indisponibilité ajoutée', tables: ['unavailabilities'], key: 'unav' });
          if (r) setNote('');
        }}>
          <input type="date" className="input" value={start} onChange={(e) => setStart(e.target.value)} aria-label="Du" />
          <input type="date" className="input" value={end} min={start} onChange={(e) => setEnd(e.target.value)} aria-label="Au" />
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Motif (facultatif)" maxLength={100} />
          <button className="btn"><Icon name="plus" size={14} />Je suis absent·e</button>
        </form>
      </div>
      <div className="list">
        {list.length === 0 && <div className="small muted" style={{ padding: '0 18px 14px' }}>Aucune indisponibilité déclarée.</div>}
        {list.map((u) => (
          <div key={u.id} className="list-item">
            <Person id={u.user_id} />
            <div className="grow small">du {fmtDate(u.start_date)} au {fmtDate(u.end_date)}{u.note && <span className="muted"> · {u.note}</span>}</div>
            {u.user_id === meId && <button className="btn btn-ghost btn-sm btn-icon" aria-label="Supprimer" onClick={async () => {
              if (await confirm({ title: 'Supprimer cette indisponibilité ?', danger: true, confirm: 'Supprimer' })) run(() => backend.remove('unavailabilities', u.id), { success: 'Supprimée', tables: ['unavailabilities'] });
            }}><Icon name="trash" size={15} /></button>}
            {u.user_id !== meId && <span className="xs muted">{name(u.user_id)}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

// =====================================================================
// Catalogue des tâches
// =====================================================================
function Catalogue() {
  const { data, run, name } = useData();
  const { openTemplate } = useModals();
  const [showArchived, setShowArchived] = useState(false);
  const c = coefs(data.household.settings);
  const zones = [...data.zones].sort((a, b) => a.position - b.position);
  const tpls = data.task_templates.filter((tp) => (showArchived ? tp.archived : !tp.archived));
  const groups = zones.map((z) => ({ z, list: tpls.filter((tp) => tp.zone_id === z.id) })).filter((g) => g.list.length || (!showArchived && g.z.active));
  const orphan = tpls.filter((tp) => !zones.some((z) => z.id === tp.zone_id));
  const weekly = (tp: TaskTemplate) => (tp.frequency === 'daily' ? 7 : tp.frequency === 'weekly' ? (tp.weekdays.length || 1) : tp.frequency === 'monthly' ? 12 / 52 : 0) * weightOf(tp.duration_min, tp.effort, c);
  const totalWeekly = data.task_templates.filter((tp) => tp.active && !tp.archived).reduce((a, tp) => a + weekly(tp), 0);

  return (
    <div className="stack">
      <div className="row-wrap">
        <button className="pill dark" onClick={() => openTemplate(null)}><Icon name="plus" size={16} />Tâche récurrente</button>
        <button className="pill" onClick={() => openTemplate(null, { frequency: 'once', once_date: today() })}><Icon name="plus" size={16} />Tâche ponctuelle</button>
      </div>
      <div className="row-wrap">
        <Seg value={showArchived ? 'arch' : 'act'} onChange={(v) => setShowArchived(v === 'arch')} options={[{ value: 'act', label: 'Tâches actives' }, { value: 'arch', label: 'Archivées' }]} />
        <span className="small muted grow">Charge hebdomadaire totale : <b>{Math.round(totalWeekly)} pts</b>, soit environ {Math.round(totalWeekly / 2)} pts par personne.</span>
      </div>
      {groups.map(({ z, list }) => (
        <div key={z.id} className="card">
          <div className="card-head">
            <h3>{z.icon} {z.name}{!z.active && <span className="badge" style={{ marginLeft: 8 }}>zone désactivée</span>}</h3>
            {!showArchived && <button className="btn btn-sm btn-ghost" onClick={() => openTemplate(null, { zone_id: z.id })}><Icon name="plus" size={14} />Ajouter</button>}
          </div>
          <div className="list">
            {list.length === 0 && <div className="small muted" style={{ padding: '12px 18px' }}>Aucune tâche.</div>}
            {list.map((tp) => (
              <div key={tp.id} className="list-item clickable" onClick={() => openTemplate(tp)}>
                <div className="grow">
                  <div className="title ellipsis">{tp.name}{!tp.active && !tp.archived && <span className="badge warning" style={{ marginLeft: 6 }}>suspendue</span>}</div>
                  <div className="meta">
                    <span>{describeFrequency(tp)}</span><span>{fmtMinutes(tp.duration_min)}</span><span>effort {EFFORT_LABEL[tp.effort].toLowerCase()}</span>
                    <span>{weightOf(tp.duration_min, tp.effort, c)} pts</span>
                    {tp.fixed_user && <span>toujours {name(tp.fixed_user)}</span>}
                    {tp.preferred_user && !tp.fixed_user && <span>préférence {name(tp.preferred_user)}</span>}
                    {tp.end_date && <span>jusqu’au {fmtDate(tp.end_date)}</span>}
                  </div>
                </div>
                {!tp.archived && (
                  <button className="btn btn-sm btn-ghost" onClick={(e) => { e.stopPropagation(); run(() => backend.update('task_templates', tp.id, { active: !tp.active }, tp.version), { success: tp.active ? 'Tâche suspendue' : 'Tâche réactivée', tables: ['task_templates'] }); }}>
                    <Icon name={tp.active ? 'pause' : 'play'} size={14} />{tp.active ? 'Suspendre' : 'Réactiver'}
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
      {orphan.length > 0 && (
        <div className="card"><div className="card-head"><h3>Sans zone</h3></div>
          <div className="list">{orphan.map((tp) => <div key={tp.id} className="list-item clickable" onClick={() => openTemplate(tp)}><div className="title grow">{tp.name}</div></div>)}</div>
        </div>
      )}
      {showArchived && tpls.length === 0 && <Empty>Aucune tâche archivée.</Empty>}
    </div>
  );
}

// =====================================================================
// Historique
// =====================================================================
function History() {
  const { data, name, zone } = useData();
  const { openOccurrence } = useModals();
  const t = today();
  const [from, setFrom] = useState(addDays(t, -30));
  const [to, setTo] = useState(t);
  const [zoneF, setZoneF] = useState('all');
  const [tplF, setTplF] = useState('all');
  const [person, setPerson] = useState('all');
  const [statusF, setStatusF] = useState('all');
  const isLate = makeIsLate(data.task_templates, t);

  const rows = useMemo(() => data.task_occurrences
    .filter((o) => !o.proposed && o.due_date >= from && o.due_date <= to)
    .filter((o) => zoneF === 'all' || o.zone_id === zoneF)
    .filter((o) => tplF === 'all' || o.template_id === tplF)
    .filter((o) => person === 'all' || o.assigned_to === person || o.done_by === person)
    .filter((o) => statusF === 'all' || o.status === statusF)
    .sort((a, b) => b.due_date.localeCompare(a.due_date)), [data.task_occurrences, from, to, zoneF, tplF, person, statusF]);

  const reassigned = (id: string) => data.activity_log.filter((l) => l.entity === 'occurrence' && l.entity_id === id && l.action === 'reassign').length;
  const comments = (id: string) => data.comments.filter((c) => c.entity === 'occurrence' && c.entity_id === id).length;

  const exportCSV = () => {
    download(`historique-taches-${from}-${to}.csv`, toCSV([
      ['Date prévue', 'Date d’origine', 'Tâche', 'Zone', 'Attribuée à', 'Statut', 'Réalisée le', 'Réalisée par', 'Durée estimée (min)', 'Durée réelle (min)', 'Charge pondérée', 'Changements d’attribution', 'Commentaires', 'Problème'],
      ...rows.map((o) => [o.due_date, o.scheduled_date, o.name, zone(o.zone_id)?.name ?? '', name(o.assigned_to), STATUS_LABEL[o.status], o.done_at ? toISO(new Date(o.done_at)) : '', o.done_by ? name(o.done_by) : '', o.estimated_min, o.actual_min ?? '', centsCSV(Math.round(Number(o.weight) * 100)), reassigned(o.id), data.comments.filter((c) => c.entity === 'occurrence' && c.entity_id === o.id).map((c) => `${name(c.user_id)}: ${c.body}`).join(' | '), o.problem ?? '']),
    ]));
  };

  return (
    <div className="card">
      <div className="card-head">
        <div className="filters grow">
          <input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Du" />
          <input type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} aria-label="Au" />
          <select className="select" value={zoneF} onChange={(e) => setZoneF(e.target.value)} aria-label="Zone"><option value="all">Toutes les zones</option>{data.zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}</select>
          <select className="select" value={tplF} onChange={(e) => setTplF(e.target.value)} aria-label="Tâche"><option value="all">Toutes les tâches</option>{[...data.task_templates].sort((a, b) => a.name.localeCompare(b.name)).map((tp) => <option key={tp.id} value={tp.id}>{tp.name}</option>)}</select>
          <select className="select" value={person} onChange={(e) => setPerson(e.target.value)} aria-label="Personne"><option value="all">Tout le monde</option>{data.members.map((m) => <option key={m.user_id} value={m.user_id}>{name(m.user_id)}</option>)}</select>
          <select className="select" value={statusF} onChange={(e) => setStatusF(e.target.value)} aria-label="Statut"><option value="all">Tous les statuts</option>{(Object.keys(STATUS_LABEL) as OccStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}</select>
        </div>
        <button className="btn btn-sm" onClick={exportCSV} disabled={!rows.length}><Icon name="download" size={14} />CSV</button>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Date</th><th>Tâche</th><th>Attribuée à</th><th>Statut</th><th>Réalisée</th><th className="right">Estimé</th><th className="right">Réel</th><th></th></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={8}><Empty>Aucune tâche sur cette période.</Empty></td></tr>}
            {rows.slice(0, 500).map((o) => (
              <tr key={o.id} className="clickable" onClick={() => openOccurrence(o.id)}>
                <td className="nowrap">{fmtDate(o.due_date)}{o.due_date !== o.scheduled_date && <div className="xs muted">prévue {fmtDate(o.scheduled_date)}</div>}</td>
                <td><div className="strong">{o.name}</div><div className="xs muted">{zone(o.zone_id)?.name}</div></td>
                <td><Person id={o.assigned_to} you={false} />{reassigned(o.id) > 0 && <div className="xs muted"><Icon name="swap" size={11} /> réattribuée</div>}</td>
                <td><StatusBadge status={o.status} late={isLate(o)} /></td>
                <td className="small">{o.done_at ? <>{fmtDate(toISO(new Date(o.done_at)))}{o.done_by && o.done_by !== o.assigned_to && <div className="xs muted">par {name(o.done_by)}</div>}</> : '—'}</td>
                <td className="right num">{o.estimated_min} min</td>
                <td className="right num">{o.actual_min != null ? `${o.actual_min} min` : '—'}</td>
                <td className="small muted">{comments(o.id) > 0 && <><Icon name="message" size={13} /> {comments(o.id)}</>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > 500 && <div className="card-foot small muted">500 premières lignes affichées sur {rows.length}. L’export CSV contient tout.</div>}
    </div>
  );
}
