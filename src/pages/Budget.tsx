import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { backend } from '../backend';
import { useData } from '../store';
import type { Budget, Expense, UUID } from '../types';
import { Empty, Field, Icon, Modal, Person, Progress, Seg, Tabs } from '../components/ui';
import { useModals } from '../components/Modals';
import { Beige, Columns, MRow, SectionTitle } from '../components/mobile';
import { fmtDate, MONTHS, today } from '../lib/dates';
import { centsToInput, computeBalances, formatMoney, parseCents, settlement } from '../lib/money';
import { budgetUsage, findBudget, inPeriod, isShared } from '../lib/budget';
import { centsCSV, download, toCSV } from '../lib/csv';
import { cx } from '../lib/util';

type Tab = 'apercu' | 'depenses' | 'soldes' | 'budgets' | 'bilan';

export default function BudgetPage() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'apercu';
  const go = (t: Tab) => setParams(t === 'apercu' ? {} : { tab: t }, { replace: true });
  return (
    <div className="mpage">
      <Tabs value={tab} onChange={go} tabs={[
        { value: 'apercu', label: 'Aperçu' }, { value: 'depenses', label: 'Dépenses' }, { value: 'soldes', label: 'Soldes' },
        { value: 'budgets', label: 'Budgets' }, { value: 'bilan', label: 'Bilan et export' },
      ]} />
      {tab === 'apercu' && <Overview go={go} />}
      {tab === 'depenses' && <Expenses />}
      {tab === 'soldes' && <Balances />}
      {tab === 'budgets' && <Budgets />}
      {tab === 'bilan' && <Report />}
    </div>
  );
}

// =====================================================================
// Aperçu (écran de la maquette)
// =====================================================================
function Overview({ go }: { go: (t: Tab) => void }) {
  const { data, memberIds, meId, name, category } = useData();
  const { openExpense, openReimbursement } = useModals();
  const money = useMoney();
  const t = today();
  const bal = computeBalances(memberIds, { expenses: data.expenses, shares: data.expense_shares, reimbursements: data.reimbursements });
  const settle = settlement(bal);
  const [y, m] = t.split('-').map(Number);
  const usage = budgetUsage(y, m, data.expenses, data.expense_shares);
  const budget = findBudget(data.budgets, 'month', y, m);
  const valid = data.expenses.filter((e) => e.status === 'validated');
  const paid = (u: string) => valid.filter((e) => e.paid_by === u).reduce((a, e) => a + e.amount_cents, 0);
  const top = Object.entries(usage.byCategory).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const maxCat = Math.max(1, ...top.map(([, v]) => v));
  const tones = ['bleu', 'rose', 'vert'] as const;
  const recent = [...data.expenses].filter((e) => e.status !== 'cancelled').sort((a, b) => b.date.localeCompare(a.date) || b.created_at.localeCompare(a.created_at)).slice(0, 5);
  const splitLabel = (e: Expense) => {
    const sh = data.expense_shares.filter((s) => s.expense_id === e.id && s.share_cents > 0);
    if (sh.length < 2) return `pour ${name(sh[0]?.user_id)}`;
    if (e.split_mode === 'equal') return '50/50';
    return memberIds.map((u) => Math.round(sh.find((s) => s.user_id === u)?.percent ?? 0)).join('/');
  };

  return (
    <div className="mgrid">
      <div className="mcol">
        <div className="lilas-card">
          <span className="small">{settle ? (settle.to === meId ? `${name(settle.from)} te doit` : `Tu dois à ${name(settle.to)}`) : 'Comptes équilibrés'}</span>
          <div className="row between" style={{ flexWrap: 'wrap' }}>
            <span className="big-amount">{settle ? money(settle.amount) : '0,00 €'}</span>
            {settle && <button className="pill dark sm" onClick={() => openReimbursement({ from_user: settle.from, to_user: settle.to, amount_cents: settle.amount, note: 'Solde' })}>Régler</button>}
          </div>
          <span className="xs muted">{memberIds.map((u) => `${name(u)} a avancé ${money(paid(u))}`).join(' · ')}</span>
        </div>
        <SectionTitle title={MONTHS[m - 1].replace(/^./, (c) => c.toUpperCase())} right={<button className="pill sm" onClick={() => go('budgets')}>{budget ? `${Math.round(usage.spent / 100)} / ${Math.round(budget.total_cents / 100)} €` : `${Math.round(usage.spent / 100)} €`}</button>} />
        {top.length ? (
          <Columns height={130} items={top.map(([cid, v], i) => ({ label: category(cid)?.name ?? 'Autre', value: `${Math.round(v / 100)} €`, tone: tones[i], ratio: v / maxCat }))} />
        ) : <Beige><div className="empty-line">Aucune dépense commune ce mois-ci.</div></Beige>}
        {budget && <Progress value={usage.spent} max={budget.total_cents} />}
      </div>
      <div className="mcol">
        <Beige title="Dépenses récentes" action={<button className="pill sm" onClick={() => go('depenses')}>Tout voir</button>}>
          {recent.length === 0 && <div className="empty-line">Aucune dépense.</div>}
          {recent.map((e) => (
            <MRow key={e.id} over={<>{name(e.paid_by)} · {splitLabel(e)} · {fmtDate(e.date)}{e.status === 'draft' ? ' · provisoire' : ''}</>} title={e.title}
              onClick={() => openExpense(e)} right={<span className="val">{money(e.amount_cents)}</span>} />
          ))}
        </Beige>
        <button className="btn btn-primary btn-big" onClick={() => openExpense(null)}><Icon name="plus" />Ajouter une dépense</button>
      </div>
    </div>
  );
}

function useMoney() {
  const { data } = useData();
  return (c: number) => formatMoney(c, data.household.currency);
}

// =====================================================================
// Dépenses
// =====================================================================
function Expenses() {
  const { data, name, category, memberIds, meId } = useData();
  const { openExpense } = useModals();
  const money = useMoney();
  const t = today();
  const [month, setMonth] = useState(t.slice(0, 7));
  const [cat, setCat] = useState('all');
  const [payer, setPayer] = useState('all');
  const [concerned, setConcerned] = useState('all');
  const [kind, setKind] = useState<'all' | 'shared' | 'individual'>('all');
  const [status, setStatus] = useState<'active' | 'all' | Expense['status']>('active');
  const [q, setQ] = useState('');

  const months = useMemo(() => [...new Set([t.slice(0, 7), ...data.expenses.map((e) => e.date.slice(0, 7))])].sort().reverse(), [data.expenses, t]);
  const shareOf = (e: Expense, u: UUID) => data.expense_shares.find((s) => s.expense_id === e.id && s.user_id === u)?.share_cents ?? 0;
  const list = data.expenses
    .filter((e) => month === 'all' || e.date.startsWith(month))
    .filter((e) => cat === 'all' || e.category_id === cat)
    .filter((e) => payer === 'all' || e.paid_by === payer)
    .filter((e) => concerned === 'all' || shareOf(e, concerned) > 0)
    .filter((e) => kind === 'all' || (kind === 'shared') === isShared(e, data.expense_shares))
    .filter((e) => (status === 'active' ? e.status !== 'cancelled' : status === 'all' || e.status === status))
    .filter((e) => !q.trim() || (e.title + ' ' + e.note).toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => b.date.localeCompare(a.date) || b.created_at.localeCompare(a.created_at));
  const validated = list.filter((e) => e.status === 'validated');
  const total = validated.reduce((a, e) => a + e.amount_cents, 0);

  return (
    <div className="card">
      <div className="card-head">
        <div className="filters grow">
          <select className="select" value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Mois">
            <option value="all">Toutes les périodes</option>
            {months.map((m) => <option key={m} value={m}>{MONTHS[Number(m.slice(5)) - 1]} {m.slice(0, 4)}</option>)}
          </select>
          <select className="select" value={cat} onChange={(e) => setCat(e.target.value)} aria-label="Catégorie">
            <option value="all">Toutes catégories</option>
            {data.categories.filter((c) => c.kind === 'expense').sort((a, b) => a.position - b.position).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select className="select" value={payer} onChange={(e) => setPayer(e.target.value)} aria-label="Payé par">
            <option value="all">Payé par tout le monde</option>
            {memberIds.map((m) => <option key={m} value={m}>Payé par {name(m)}</option>)}
          </select>
          <select className="select" value={concerned} onChange={(e) => setConcerned(e.target.value)} aria-label="Personne concernée">
            <option value="all">Toutes personnes concernées</option>
            {memberIds.map((m) => <option key={m} value={m}>Concerne {name(m)}</option>)}
          </select>
          <select className="select" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} aria-label="Type">
            <option value="all">Communes et individuelles</option><option value="shared">Communes</option><option value="individual">Individuelles</option>
          </select>
          <select className="select" value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="Statut">
            <option value="active">Validées et provisoires</option><option value="validated">Validées</option><option value="draft">Provisoires</option><option value="cancelled">Annulées</option><option value="all">Tous statuts</option>
          </select>
          <input className="input" type="search" placeholder="Rechercher…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Rechercher" />
        </div>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Date</th><th>Dépense</th><th>Payé par</th><th className="right">Montant</th><th className="right hide-sm">Ma part</th></tr></thead>
          <tbody>
            {list.length === 0 && <tr><td colSpan={5}><Empty icon="wallet">Aucune dépense pour ces filtres.</Empty></td></tr>}
            {list.map((e) => (
              <tr key={e.id} className={cx('clickable', e.status === 'cancelled' && 'cancelled')} onClick={() => openExpense(e)}>
                <td className="nowrap">{fmtDate(e.date)}</td>
                <td>
                  <div className="strong">{e.title} {e.status === 'draft' && <span className="badge warning">provisoire</span>}{e.status === 'cancelled' && <span className="badge">annulée</span>}</div>
                  <div className="xs muted">{category(e.category_id)?.name ?? '—'} · {isShared(e, data.expense_shares) ? (e.split_mode === 'equal' ? 'partagée 50/50' : e.split_mode === 'percent' ? 'partagée en %' : 'montants fixes') : `pour ${name(data.expense_shares.find((s) => s.expense_id === e.id && s.share_cents > 0)?.user_id)}`}</div>
                </td>
                <td><Person id={e.paid_by} you={false} /></td>
                <td className="right num strong">{money(e.amount_cents)}</td>
                <td className="right num hide-sm">{money(shareOf(e, meId))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card-foot small">Total validé : <b className="num">{money(total)}</b> · {validated.length} dépense{validated.length > 1 ? 's' : ''}{list.some((e) => e.status === 'draft') && ' · les dépenses provisoires ne comptent pas'}</div>
    </div>
  );
}

// =====================================================================
// Soldes et remboursements
// =====================================================================
function Balances() {
  const { data, memberIds, meId, name, run } = useData();
  const { openReimbursement } = useModals();
  const money = useMoney();
  const bal = computeBalances(memberIds, { expenses: data.expenses, shares: data.expense_shares, reimbursements: data.reimbursements });
  const settle = settlement(bal);
  const valid = data.expenses.filter((e) => e.status === 'validated');
  const per = memberIds.map((m) => ({
    id: m,
    paid: valid.filter((e) => e.paid_by === m).reduce((a, e) => a + e.amount_cents, 0),
    borne: data.expense_shares.filter((s) => s.user_id === m && valid.some((e) => e.id === s.expense_id)).reduce((a, s) => a + s.share_cents, 0),
    sent: data.reimbursements.filter((r) => r.status === 'done' && r.from_user === m).reduce((a, r) => a + r.amount_cents, 0),
    received: data.reimbursements.filter((r) => r.status === 'done' && r.to_user === m).reduce((a, r) => a + r.amount_cents, 0),
  }));
  const planned = data.reimbursements.filter((r) => r.status === 'planned').sort((a, b) => a.date.localeCompare(b.date));
  const history = data.reimbursements.filter((r) => r.status !== 'planned').sort((a, b) => b.date.localeCompare(a.date));

  return (
    <div className="stack">
      <div className="card card-pad stack">
        <div className="row-wrap">
          <div className="grow">
            <div className="stat-label">Solde net</div>
            {settle ? (
              <div className="stat-value">{name(settle.from)} doit {money(settle.amount)} à {name(settle.to)}</div>
            ) : <div className="stat-value">Comptes équilibrés ✓</div>}
          </div>
          {settle && <button className="btn btn-primary" onClick={() => openReimbursement({ from_user: settle.from, to_user: settle.to, amount_cents: settle.amount, note: 'Solde' })}><Icon name="check" />Enregistrer le règlement</button>}
          {settle && <button className="btn" onClick={() => openReimbursement({ from_user: settle.from, to_user: settle.to, amount_cents: settle.amount, status: 'planned' })}>Planifier</button>}
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th></th>{per.map((p) => <th key={p.id} className="right">{name(p.id)}{p.id === meId ? ' (vous)' : ''}</th>)}</tr></thead>
            <tbody>
              <tr><td>A avancé (dépenses payées)</td>{per.map((p) => <td key={p.id} className="right num">{money(p.paid)}</td>)}</tr>
              <tr><td>Part réellement supportée</td>{per.map((p) => <td key={p.id} className="right num">− {money(p.borne)}</td>)}</tr>
              <tr><td>Remboursements versés</td>{per.map((p) => <td key={p.id} className="right num">+ {money(p.sent)}</td>)}</tr>
              <tr><td>Remboursements reçus</td>{per.map((p) => <td key={p.id} className="right num">− {money(p.received)}</td>)}</tr>
              <tr><td className="strong">Solde</td>{per.map((p) => <td key={p.id} className={cx('right num strong', bal[p.id] < 0 ? 'danger-text' : bal[p.id] > 0 ? 'success-text' : '')}>{bal[p.id] > 0 ? '+' : ''}{money(bal[p.id])}</td>)}</tr>
            </tbody>
          </table>
        </div>
        <p className="xs muted">Solde positif : on doit de l’argent à cette personne. Seules les dépenses validées et les remboursements effectués sont comptés ; un remboursement n’est jamais une dépense commune.</p>
      </div>

      <div className="grid grid-2">
        <div className="card">
          <div className="card-head"><h3>Remboursements prévus</h3></div>
          <div className="list">
            {planned.length === 0 && <Empty icon="clock">Aucun remboursement en attente.</Empty>}
            {planned.map((r) => (
              <div key={r.id} className="list-item">
                <div className="grow clickable" onClick={() => openReimbursement(undefined, r)} style={{ cursor: 'pointer' }}>
                  <div className="title">{name(r.from_user)} → {name(r.to_user)}</div>
                  <div className="meta">prévu le {fmtDate(r.date)}{r.note && ` · ${r.note}`}</div>
                </div>
                <span className="num strong">{money(r.amount_cents)}</span>
                <button className="btn btn-sm" onClick={() => run(() => backend.update('reimbursements', r.id, { status: 'done', date: today() }, r.version), { success: 'Remboursement effectué', tables: ['reimbursements'], key: 'r-' + r.id })}>Effectué</button>
              </div>
            ))}
          </div>
        </div>
        <div className="card">
          <div className="card-head"><h3>Historique des remboursements</h3></div>
          <div className="list">
            {history.length === 0 && <Empty icon="swap">Aucun remboursement.</Empty>}
            {history.map((r) => (
              <div key={r.id} className={cx('list-item clickable', r.status === 'cancelled' && 'is-done')} onClick={() => openReimbursement(undefined, r)}>
                <div className="grow"><div className="title">{name(r.from_user)} → {name(r.to_user)}</div><div className="meta">{fmtDate(r.date)}{r.note && ` · ${r.note}`}{r.status === 'cancelled' && ' · annulé'}</div></div>
                <span className="num strong">{money(r.amount_cents)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// =====================================================================
// Budgets mensuels et annuels
// =====================================================================
function Budgets() {
  const { data } = useData();
  const money = useMoney();
  const t = today();
  const [period, setPeriod] = useState<'month' | 'year'>('month');
  const [year, setYear] = useState(Number(t.slice(0, 4)));
  const [month, setMonth] = useState(Number(t.slice(5, 7)));
  const [editing, setEditing] = useState(false);
  const m = period === 'year' ? 0 : month;
  const budget = findBudget(data.budgets, period, year, month);
  const usage = budgetUsage(year, m, data.expenses, data.expense_shares);
  const prev = period === 'year' ? { y: year - 1, m: 0 } : month === 1 ? { y: year - 1, m: 12 } : { y: year, m: month - 1 };
  const prevUsage = budgetUsage(prev.y, prev.m, data.expenses, data.expense_shares);
  const diff = usage.spent - prevUsage.spent;
  const cats = data.categories.filter((c) => c.kind === 'expense').sort((a, b) => a.position - b.position);
  const catRows = cats.map((c) => ({ c, spent: usage.byCategory[c.id] ?? 0, limit: budget?.category_limits?.[c.id] })).filter((r) => r.spent > 0 || r.limit);
  const years = [...new Set([year, Number(t.slice(0, 4)), ...data.expenses.map((e) => Number(e.date.slice(0, 4)))])].sort();

  // Comparaison : 6 derniers mois ou années disponibles
  const compare = period === 'month'
    ? Array.from({ length: 6 }, (_, i) => {
        const d = new Date(year, month - 1 - (5 - i), 1);
        const yy = d.getFullYear(), mm = d.getMonth() + 1;
        return { label: MONTHS[mm - 1].slice(0, 4) + '.', spent: budgetUsage(yy, mm, data.expenses, data.expense_shares).spent, budget: findBudget(data.budgets, 'month', yy, mm)?.total_cents };
      })
    : years.slice(-5).map((yy) => ({ label: String(yy), spent: budgetUsage(yy, 0, data.expenses, data.expense_shares).spent, budget: findBudget(data.budgets, 'year', yy, 0)?.total_cents }));
  const maxC = Math.max(1, ...compare.map((c) => Math.max(c.spent, c.budget ?? 0)));

  return (
    <div className="stack">
      <div className="row-wrap">
        <Seg value={period} onChange={setPeriod} options={[{ value: 'month', label: 'Mensuel' }, { value: 'year', label: 'Annuel' }]} />
        {period === 'month' && <select className="select" style={{ width: 'auto' }} value={month} onChange={(e) => setMonth(Number(e.target.value))} aria-label="Mois">{MONTHS.map((n, i) => <option key={n} value={i + 1}>{n}</option>)}</select>}
        <select className="select" style={{ width: 'auto' }} value={year} onChange={(e) => setYear(Number(e.target.value))} aria-label="Année">{years.map((y) => <option key={y}>{y}</option>)}</select>
        <span className="grow" />
        <button className="btn" onClick={() => setEditing(true)}><Icon name={budget ? 'edit' : 'plus'} size={15} />{budget ? 'Modifier le budget' : 'Créer un budget'}</button>
      </div>

      <div className="grid grid-4">
        <div className="card stat"><span className="stat-label">Montant prévu</span><span className="stat-value">{budget ? money(budget.total_cents) : '—'}</span></div>
        <div className="card stat"><span className="stat-label">Dépensé en commun</span><span className="stat-value">{money(usage.spent)}</span><span className="stat-sub">{usage.expenses.length} dépense{usage.expenses.length > 1 ? 's' : ''}</span></div>
        <div className="card stat"><span className="stat-label">Reste</span><span className={cx('stat-value', budget && usage.spent > budget.total_cents && 'danger-text')}>{budget ? money(budget.total_cents - usage.spent) : '—'}</span>
          {budget && <span className="stat-sub">{Math.round((usage.spent / Math.max(1, budget.total_cents)) * 100)} % consommé</span>}</div>
        <div className="card stat"><span className="stat-label">Vs période précédente</span><span className={cx('stat-value', diff > 0 ? 'danger-text' : 'success-text')}>{prevUsage.spent ? `${diff > 0 ? '+' : ''}${money(diff)}` : '—'}</span>
          <span className="stat-sub">{prevUsage.spent ? `${diff > 0 ? '+' : ''}${Math.round((diff / prevUsage.spent) * 100)} %` : 'pas de données'}</span></div>
      </div>

      {budget && (
        <div className="card card-pad stack-sm">
          <Progress value={usage.spent} max={budget.total_cents} />
          {usage.spent > budget.total_cents && <span className="small danger-text strong"><Icon name="alert" size={14} /> Budget dépassé de {money(usage.spent - budget.total_cents)}</span>}
        </div>
      )}

      <div className="grid grid-2">
        <div className="card">
          <div className="card-head"><h3>Par catégorie</h3></div>
          <div className="list">
            {catRows.length === 0 && <Empty>Aucune dépense commune sur la période.</Empty>}
            {catRows.map(({ c, spent, limit }) => (
              <div key={c.id} className="list-item" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
                <div className="row between"><span className="strong">{c.name}</span><span className="num small">{money(spent)}{limit ? <span className="muted"> / {money(limit)}</span> : ''}</span></div>
                {limit ? <Progress value={spent} max={limit} /> : null}
                {limit && spent > limit ? <span className="xs danger-text">Dépassement de {money(spent - limit)}</span> : null}
              </div>
            ))}
            {usage.byCategory.none ? <div className="list-item"><span className="grow">Sans catégorie</span><span className="num small">{money(usage.byCategory.none)}</span></div> : null}
          </div>
        </div>
        <div className="card">
          <div className="card-head"><h3>Comparaison</h3></div>
          <div className="card-body">
            <div className="bars">
              {compare.map((c) => (
                <div key={c.label} className="col" title={`${money(c.spent)}${c.budget ? ` / ${money(c.budget)}` : ''}`}>
                  <div className="pair">
                    <div className={cx('single', c.budget !== undefined && c.spent > c.budget && 'over')} style={{ height: `${(c.spent / maxC) * 100}%`, width: '45%' }} />
                    {c.budget !== undefined && <div style={{ height: `${(c.budget / maxC) * 100}%`, width: '25%', background: 'var(--surface-3)', borderRadius: '4px 4px 0 0' }} />}
                  </div>
                  <span className="xs muted">{c.label}</span>
                </div>
              ))}
            </div>
            <div className="legend" style={{ marginTop: 8 }}><span><i style={{ background: 'var(--accent)' }} />Dépensé</span><span><i style={{ background: 'var(--surface-3)' }} />Budget</span><span><i style={{ background: 'var(--danger)' }} />Dépassement</span></div>
          </div>
        </div>
      </div>
      <p className="xs muted">Seules les dépenses communes validées (partagées entre vous deux) entrent dans le budget commun. Les dépenses à la charge d’une seule personne n’y sont pas comptées.</p>
      {editing && <BudgetModal period={period} year={year} month={m} budget={budget} onClose={() => setEditing(false)} />}
    </div>
  );
}

function BudgetModal({ period, year, month, budget, onClose }: { period: 'month' | 'year'; year: number; month: number; budget?: Budget; onClose: () => void }) {
  const { data, run } = useData();
  const cats = data.categories.filter((c) => c.kind === 'expense' && !c.archived).sort((a, b) => a.position - b.position);
  const [total, setTotal] = useState(budget ? centsToInput(budget.total_cents) : '');
  const [limits, setLimits] = useState<Record<UUID, string>>(() => Object.fromEntries(cats.map((c) => [c.id, budget?.category_limits?.[c.id] ? centsToInput(budget.category_limits[c.id]) : ''])));
  const [err, setErr] = useState('');
  const save = async () => {
    const tc = parseCents(total);
    if (tc === null) return setErr('Montant global invalide.');
    const cl: Record<UUID, number> = {};
    for (const [k, v] of Object.entries(limits)) {
      if (!v.trim()) continue;
      const c = parseCents(v);
      if (c === null) return setErr('Une limite de catégorie est invalide.');
      cl[k] = c;
    }
    const r = await run<unknown>(() => budget
      ? backend.update('budgets', budget.id, { total_cents: tc, category_limits: cl }, budget.version)
      : backend.insert('budgets', { household_id: data.household.id, period, year, month, total_cents: tc, category_limits: cl }),
    { success: 'Budget enregistré', tables: ['budgets'], key: 'budget' });
    if (r) onClose();
  };
  const remove = async () => {
    if (!budget) return;
    const r = await run(() => backend.remove('budgets', budget.id), { success: 'Budget supprimé', tables: ['budgets'] });
    if (r !== undefined) onClose();
  };
  return (
    <Modal title={`Budget ${period === 'year' ? `annuel ${year}` : `${MONTHS[month - 1]} ${year}`}`} onClose={onClose} footer={
      <>{budget && <button className="btn btn-danger" style={{ marginRight: 'auto' }} onClick={remove}>Supprimer</button>}<button className="btn" onClick={onClose}>Annuler</button><button className="btn btn-primary" onClick={save}>Enregistrer</button></>
    }>
      <Field label={`Montant global (${data.household.currency})`} hint={period === 'year' ? 'Défini indépendamment des budgets mensuels (dépenses saisonnières, exceptionnelles…)' : undefined}>
        <input className="input num" inputMode="decimal" value={total} onChange={(e) => setTotal(e.target.value)} placeholder="0,00" />
      </Field>
      <div className="form-section">
        <h4>Limites par catégorie (facultatives)</h4>
        <div className="form-grid">
          {cats.map((c) => (
            <Field key={c.id} label={c.name}><input className="input input-sm num" inputMode="decimal" value={limits[c.id]} onChange={(e) => setLimits({ ...limits, [c.id]: e.target.value })} placeholder="—" /></Field>
          ))}
        </div>
      </div>
      {err && <div className="error-box">{err}</div>}
    </Modal>
  );
}

// =====================================================================
// Bilan annuel et exports
// =====================================================================
function Report() {
  const { data, memberIds, name, category } = useData();
  const money = useMoney();
  const t = today();
  const years = [...new Set([Number(t.slice(0, 4)), ...data.expenses.map((e) => Number(e.date.slice(0, 4)))])].sort().reverse();
  const [year, setYear] = useState(years[0]);
  const valid = data.expenses.filter((e) => e.status === 'validated' && inPeriod(e.date, year, 0));
  const shared = valid.filter((e) => isShared(e, data.expense_shares));
  const individual = valid.filter((e) => !isShared(e, data.expense_shares));
  const sum = (l: Expense[]) => l.reduce((a, e) => a + e.amount_cents, 0);
  const cats = data.categories.filter((c) => c.kind === 'expense').sort((a, b) => a.position - b.position);
  const matrix = cats.map((c) => ({ c, months: Array.from({ length: 12 }, (_, i) => sum(valid.filter((e) => e.category_id === c.id && Number(e.date.slice(5, 7)) === i + 1))) })).filter((r) => r.months.some(Boolean));
  const monthTotals = Array.from({ length: 12 }, (_, i) => sum(valid.filter((e) => Number(e.date.slice(5, 7)) === i + 1)));

  const exportExpenses = () => download(`depenses-${year}.csv`, toCSV([
    ['Date', 'Titre', 'Catégorie', 'Montant', 'Payé par', 'Mode de partage', ...memberIds.map((m) => `Part ${name(m)}`), 'Type', 'Statut', 'Note'],
    ...data.expenses.filter((e) => inPeriod(e.date, year, 0)).sort((a, b) => a.date.localeCompare(b.date)).map((e) => [
      e.date, e.title, category(e.category_id)?.name ?? '', centsCSV(e.amount_cents), name(e.paid_by),
      { equal: 'Parts égales', percent: 'Pourcentage', fixed: 'Montants fixes', single: 'Une personne' }[e.split_mode],
      ...memberIds.map((m) => centsCSV(data.expense_shares.find((s) => s.expense_id === e.id && s.user_id === m)?.share_cents ?? 0)),
      isShared(e, data.expense_shares) ? 'Commune' : 'Individuelle', { draft: 'Provisoire', validated: 'Validée', cancelled: 'Annulée' }[e.status], e.note,
    ]),
  ]));
  const exportReimb = () => download(`remboursements-${year}.csv`, toCSV([
    ['Date', 'De', 'À', 'Montant', 'Statut', 'Commentaire'],
    ...data.reimbursements.filter((r) => inPeriod(r.date, year, 0)).sort((a, b) => a.date.localeCompare(b.date)).map((r) => [r.date, name(r.from_user), name(r.to_user), centsCSV(r.amount_cents), { planned: 'Prévu', done: 'Effectué', cancelled: 'Annulé' }[r.status], r.note]),
  ]));
  const exportSummary = () => download(`recapitulatif-${year}.csv`, toCSV([
    ['Catégorie', ...MONTHS, 'Total'],
    ...matrix.map((r) => [r.c.name, ...r.months.map(centsCSV), centsCSV(r.months.reduce((a, b) => a + b, 0))]),
    ['Total', ...monthTotals.map(centsCSV), centsCSV(sum(valid))],
    [],
    ['Dépenses communes', centsCSV(sum(shared))],
    ['Dépenses individuelles', centsCSV(sum(individual))],
    ...memberIds.map((m) => [`Payé par ${name(m)}`, centsCSV(sum(valid.filter((e) => e.paid_by === m)))]),
    ...memberIds.map((m) => [`Part supportée par ${name(m)}`, centsCSV(data.expense_shares.filter((s) => s.user_id === m && valid.some((e) => e.id === s.expense_id)).reduce((a, s) => a + s.share_cents, 0))]),
  ]));

  return (
    <div className="stack">
      <div className="row-wrap">
        <select className="select" style={{ width: 'auto' }} value={year} onChange={(e) => setYear(Number(e.target.value))} aria-label="Année">{years.map((y) => <option key={y}>{y}</option>)}</select>
        <span className="grow" />
        <button className="btn btn-sm" onClick={exportExpenses}><Icon name="download" size={14} />Dépenses CSV</button>
        <button className="btn btn-sm" onClick={exportReimb}><Icon name="download" size={14} />Remboursements CSV</button>
        <button className="btn btn-sm" onClick={exportSummary}><Icon name="download" size={14} />Récapitulatif annuel</button>
      </div>
      <div className="grid grid-4">
        <div className="card stat"><span className="stat-label">Total {year}</span><span className="stat-value">{money(sum(valid))}</span></div>
        <div className="card stat"><span className="stat-label">Communes</span><span className="stat-value">{money(sum(shared))}</span></div>
        <div className="card stat"><span className="stat-label">Individuelles</span><span className="stat-value">{money(sum(individual))}</span></div>
        <div className="card stat"><span className="stat-label">Payé par personne</span>{memberIds.map((m) => <span key={m} className="stat-sub row between"><span>{name(m)}</span><b className="num">{money(sum(valid.filter((e) => e.paid_by === m)))}</b></span>)}</div>
      </div>
      <div className="card">
        <div className="card-head"><h3>Dépenses par catégorie et par mois</h3></div>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Catégorie</th>{MONTHS.map((n) => <th key={n} className="right">{n.slice(0, 3)}</th>)}<th className="right">Total</th></tr></thead>
            <tbody>
              {matrix.length === 0 && <tr><td colSpan={14}><Empty>Aucune dépense validée en {year}.</Empty></td></tr>}
              {matrix.map((r) => <tr key={r.c.id}><td className="nowrap">{r.c.name}</td>{r.months.map((v, i) => <td key={i} className="right num small">{v ? (v / 100).toFixed(0) : '·'}</td>)}<td className="right num strong">{money(r.months.reduce((a, b) => a + b, 0))}</td></tr>)}
              {matrix.length > 0 && <tr><td className="strong">Total</td>{monthTotals.map((v, i) => <td key={i} className="right num small strong">{v ? (v / 100).toFixed(0) : '·'}</td>)}<td className="right num strong">{money(sum(valid))}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
