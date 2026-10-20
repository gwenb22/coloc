import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { backend } from '../backend';
import { useData } from '../store';
import { Icon, Progress, Seg } from '../components/ui';
import { SwapActions, useModals } from '../components/Modals';
import { TaskMRow, TaskRow } from '../components/TaskRow';
import { Beige, Columns, MRow, SectionTitle, StatPill } from '../components/mobile';
import { PrivateRow, PrivateTaskModal } from '../components/Bedroom';
import type { PrivateTask } from '../types';
import { addDays, fmtDate, startOfWeek, today } from '../lib/dates';
import { fairnessStats, isOpen, makeIsLate } from '../lib/fairness';
import { computeBalances, formatMoney, settlement } from '../lib/money';
import { budgetUsage, findBudget } from '../lib/budget';
import { fmtMinutes, plural } from '../lib/util';

export default function Dashboard() {
  const { data, meId, memberIds, name, run, category } = useData();
  const { openTemplate, openExpense, openReimbursement, openShopping } = useModals();
  const [who, setWho] = useState<'me' | 'all'>('me');
  const [roomTask, setRoomTask] = useState<PrivateTask | null>(null);
  const t = today();
  const isLate = makeIsLate(data.task_templates, t);
  const cur = data.household.currency;

  // Tâches du jour : terminées en haut, puis retards, puis à faire ; la dernière ouverte est dépliée
  const active = data.task_occurrences.filter((o) => !o.proposed && o.status !== 'cancelled');
  const mine = (o: { assigned_to: string | null }) => who === 'all' || o.assigned_to === meId;
  const late = active.filter((o) => isLate(o) && mine(o)).sort((a, b) => a.due_date.localeCompare(b.due_date));
  const todayList = active.filter((o) => o.due_date === t && !isLate(o) && mine(o));
  const stack = [...todayList.filter((o) => o.status === 'done'), ...late, ...todayList.filter((o) => o.status !== 'done')];
  const lastOpen = [...stack].reverse().find(isOpen);
  const upcoming = active.filter((o) => o.due_date > t && o.due_date <= addDays(t, 5) && isOpen(o) && mine(o)).sort((a, b) => a.due_date.localeCompare(b.due_date)).slice(0, 5);
  const proposals = data.task_occurrences.filter((o) => o.proposed && isOpen(o)).length;
  // Ma chambre (privé) : ce qui est prévu aujourd'hui ou en retard
  const myRoom = (data.private_tasks ?? []).filter((x) => !x.done && x.due_date && x.due_date <= t).sort((a, b) => a.due_date!.localeCompare(b.due_date!));

  const myOpen = data.task_occurrences.filter((o) => o.assigned_to === meId && !o.proposed && isOpen(o) && o.due_date <= t);
  const myLate = myOpen.filter((o) => isLate(o)).length;
  const ws = startOfWeek(t);
  const weekStats = fairnessStats(data.task_occurrences, memberIds, ws, addDays(ws, 6));
  const fourWeeks = fairnessStats(data.task_occurrences, memberIds, addDays(ws, -21), addDays(ws, 6));

  const balances = useMemo(() => computeBalances(memberIds, { expenses: data.expenses, shares: data.expense_shares, reimbursements: data.reimbursements }), [data, memberIds]);
  const settle = settlement(balances);
  const solde = settle ? `${settle.to === meId ? '+' : '−'}${Math.round(settle.amount / 100)} €` : '0 €';
  const [y, m] = t.split('-').map(Number);
  const monthBudget = findBudget(data.budgets, 'month', y, m);
  const usage = budgetUsage(y, m, data.expenses, data.expense_shares);
  const recent = [...data.expenses].filter((e) => e.status !== 'cancelled').sort((a, b) => b.date.localeCompare(a.date) || b.created_at.localeCompare(a.created_at)).slice(0, 3);
  const toBuy = data.shopping_items.filter((s) => s.status === 'to_buy').sort((a, b) => Number(b.priority === 'high') - Number(a.priority === 'high'));
  const swapsForMe = data.swap_requests.filter((s) => s.status === 'pending' && s.to_user === meId);

  const [a, b] = memberIds;
  const pa = fourWeeks.per[a]?.weighted ?? 0, pb = b ? fourWeeks.per[b]?.weighted ?? 0 : 0;
  const maxP = Math.max(1, pa, pb);

  return (
    <div className="mpage">
      <div className="greet">
        <h1>Bonjour {name(meId)} 👋</h1>
        <p>{new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }).replace(/^./, (c) => c.toUpperCase())}</p>
      </div>

      <div className="hscroll">
        <button className="pill dark" onClick={() => openExpense(null)}><Icon name="plus" size={16} />Dépense</button>
        <button className="pill" onClick={() => openTemplate(null, { frequency: 'once', once_date: t })}><Icon name="plus" size={16} />Tâche</button>
        <button className="pill" onClick={() => openShopping(null)}><Icon name="cart" size={16} />Course</button>
        <button className="pill" onClick={() => openReimbursement(settle && settle.from === meId ? { from_user: settle.from, to_user: settle.to, amount_cents: settle.amount } : undefined)}><Icon name="swap" size={16} />Remboursement</button>
      </div>

      <div className="stat-row">
        <StatPill label="À faire" value={plural(myOpen.length, 'tâche')} alert={myLate > 0} />
        <StatPill label="Semaine" value={fmtMinutes(weekStats.per[meId]?.estimated_min ?? 0)} />
        <StatPill label="Solde" value={solde} />
      </div>

      {swapsForMe.map((s) => {
        const o = data.task_occurrences.find((x) => x.id === s.occurrence_id);
        return (
          <div key={s.id} className="soft-card t-jaune" style={{ flexWrap: 'wrap' }}>
            <Icon name="swap" />
            <div className="grow"><b>{name(s.from_user)}</b> te demande de reprendre « {o?.name} » ({o && fmtDate(o.due_date)}){s.message && <span className="muted"> · « {s.message} »</span>}</div>
            <SwapActions swapId={s.id} />
          </div>
        );
      })}
      {proposals > 0 && (
        <Link to="/taches?tab=repartition" className="soft-card t-lilas">
          <Icon name="sparkles" />
          <div className="grow"><b>{plural(proposals, 'tâche proposée', 'tâches proposées')}</b> <span className="muted">à vérifier puis confirmer</span></div>
          <Icon name="arrowRight" />
        </Link>
      )}

      <div className="mgrid">
        <div className="mcol">
          <SectionTitle title="Aujourd’hui" right={<Seg value={who} onChange={setWho} options={[{ value: 'me', label: 'Moi' }, { value: 'all', label: 'Tous' }]} />} />
          {stack.length > 0 ? (
            <div className="task-stack" style={{ padding: 0 }}>
              {stack.map((o) => <TaskRow key={o.id} o={o} late={isLate(o)} card expanded={o.id === lastOpen?.id} showDate={isLate(o)} showPerson={who === 'all'} />)}
            </div>
          ) : (
            <Beige><div className="empty-line">Rien à faire aujourd’hui 🎉</div></Beige>
          )}
          {myRoom.length > 0 && (
            <Beige title={<>Ma chambre <span className="xs muted">🔒 privé</span></>} action={<Link to="/taches?tab=chambre" className="pill sm">Tout voir</Link>}>
              {myRoom.map((x) => <PrivateRow key={x.id} t={x} onOpen={setRoomTask} />)}
            </Beige>
          )}
          {roomTask && <PrivateTaskModal task={roomTask} onClose={() => setRoomTask(null)} />}
          {upcoming.length > 0 && (
            <>
              <SectionTitle title="Prochains jours" right={<Link to="/taches">Tout voir</Link>} />
              <Beige>
                {upcoming.map((o) => <TaskMRow key={o.id} o={o} showPerson={who === 'all'} over={<>{fmtDate(o.due_date, { weekday: 'long', day: 'numeric' })} · {data.zones.find((z) => z.id === o.zone_id)?.name} · {fmtMinutes(o.estimated_min)}</>} />)}
              </Beige>
            </>
          )}
        </div>

        <div className="mcol">
          <SectionTitle title="Équilibre" right={<Link to="/taches?tab=repartition">4 semaines</Link>} />
          <Columns height={140} items={[
            { label: name(a), value: `${Math.round(pa)} pts`, tone: 'rose', ratio: pa / maxP },
            ...(b ? [{ label: name(b), value: `${Math.round(pb)} pts`, tone: 'vert' as const, ratio: pb / maxP }] : []),
            { label: 'Écart', value: `${Math.round(fourWeeks.gap)} pts`, tone: 'bleu', ratio: fourWeeks.gap / maxP },
          ]} />

          <SectionTitle title="Budget du mois" right={<Link to="/budget">Détail</Link>} />
          <Link to="/budget" className="lilas-card" style={{ textDecoration: 'none' }}>
            <span className="muted small">Dépensé en commun</span>
            <span className="big-amount" style={{ fontSize: 28 }}>{formatMoney(usage.spent, cur)}</span>
            {monthBudget ? (
              <>
                <Progress value={usage.spent} max={monthBudget.total_cents} />
                <span className="small muted">{usage.spent > monthBudget.total_cents ? `Dépassement de ${formatMoney(usage.spent - monthBudget.total_cents, cur)}` : `Reste ${formatMoney(monthBudget.total_cents - usage.spent, cur)} sur ${formatMoney(monthBudget.total_cents, cur)}`}</span>
              </>
            ) : <span className="small muted">Aucun budget défini pour ce mois</span>}
          </Link>

          <SectionTitle title="Courses" right={<Link to="/courses">{plural(toBuy.length, 'article')}</Link>} />
          <Beige>
            {toBuy.length === 0 && <div className="empty-line">La liste est vide.</div>}
            {toBuy.slice(0, 4).map((s) => (
              <MRow key={s.id} over={<>{s.category}{s.quantity !== 1 || s.unit ? ` · ${s.quantity} ${s.unit}` : ''}{s.priority === 'high' ? ' · urgent' : ''}</>} title={s.name} onClick={() => openShopping(s)}
                check={{ done: false, label: `${s.name} acheté`, onToggle: () => run(() => backend.update('shopping_items', s.id, { status: 'bought', bought_at: new Date().toISOString(), bought_by: meId }, s.version), { success: `${s.name} acheté`, tables: ['shopping_items'] }) }} />
            ))}
          </Beige>

          <SectionTitle title="Dépenses récentes" right={<Link to="/budget?tab=depenses">Tout voir</Link>} />
          <Beige>
            {recent.length === 0 && <div className="empty-line">Aucune dépense.</div>}
            {recent.map((e) => (
              <MRow key={e.id} over={<>{name(e.paid_by)} · {fmtDate(e.date)} · {category(e.category_id)?.name}</>} title={e.title} onClick={() => openExpense(e)}
                right={<span className="val">{formatMoney(e.amount_cents, cur)}</span>} />
            ))}
          </Beige>
        </div>
      </div>
    </div>
  );
}
