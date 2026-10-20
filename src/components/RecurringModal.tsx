import { useMemo, useState } from 'react';
import { backend } from '../backend';
import { useData } from '../store';
import type { RecurringExpense, SplitInput, SplitMode, UUID } from '../types';
import { Field, Modal, PersonSelect, Seg, useConfirm } from './ui';
import { centsToInput, computeShares, formatMoney, parseCents, SplitError } from '../lib/money';
import { nextDate } from '../lib/recurring';
import { fmtDate, today } from '../lib/dates';

/** Création / modification d'une dépense récurrente (loyer, abonnements…). */
export function RecurringModal({ rule, onClose }: { rule: RecurringExpense | null; onClose: () => void }) {
  const { data, run, memberIds, meId, name } = useData();
  const confirm = useConfirm();
  const cats = data.categories.filter((c) => c.kind === 'expense' && (!c.archived || c.id === rule?.category_id)).sort((a, b) => a.position - b.position);
  const [title, setTitle] = useState(rule?.title ?? '');
  const [amount, setAmount] = useState(rule ? centsToInput(rule.amount_cents) : '');
  const [day, setDay] = useState(rule?.day_of_month ?? Number(today().slice(8)));
  const [cat, setCat] = useState<UUID | null>(rule?.category_id ?? cats.find((c) => c.name === 'Loyer')?.id ?? cats[0]?.id ?? null);
  const [paidBy, setPaidBy] = useState<UUID>(rule?.paid_by ?? meId);
  // Le mode « montants fixes » est édité en pourcentage, pour rester valable si le montant change
  const [mode, setMode] = useState<Exclude<SplitMode, 'fixed'>>(rule?.split_mode === 'fixed' ? 'percent' : (rule?.split_mode as Exclude<SplitMode, 'fixed'>) ?? 'equal');
  const initialPct = (m: UUID) => {
    const inp = rule?.split_inputs.find((i) => i.user_id === m);
    if (!rule) return '50';
    if (rule.split_mode === 'percent') return String(inp?.value ?? 0);
    if (rule.split_mode === 'fixed') return String(Math.round(((inp?.value ?? 0) / rule.amount_cents) * 1000) / 10);
    return '50';
  };
  const [pct, setPct] = useState<Record<UUID, string>>(() => Object.fromEntries(memberIds.map((m) => [m, initialPct(m)])));
  const [single, setSingle] = useState<UUID>(() => (rule?.split_mode === 'single' ? rule.split_inputs[0]?.user_id : null) ?? memberIds.find((m) => m !== meId) ?? meId);
  const [start, setStart] = useState(rule?.start_date ?? today());
  const [end, setEnd] = useState(rule?.end_date ?? '');
  const [auto, setAuto] = useState(rule?.auto_validate ?? true);
  const [active, setActive] = useState(rule?.active ?? true);
  const [note, setNote] = useState(rule?.note ?? '');
  const [err, setErr] = useState('');
  const cents = parseCents(amount);

  const inputs: SplitInput[] = mode === 'single' ? [{ user_id: single }]
    : mode === 'percent' ? memberIds.map((m) => ({ user_id: m, value: Number(pct[m]?.replace(',', '.') || 0) }))
    : memberIds.map((m) => ({ user_id: m, included: true }));
  const preview = useMemo(() => {
    if (!cents) return { error: '', shares: [] as ReturnType<typeof computeShares> };
    try {
      return { error: '', shares: computeShares(cents, mode, inputs) };
    } catch (e) {
      return { error: e instanceof SplitError ? e.message : 'Répartition invalide.', shares: [] };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cents, mode, pct, single, memberIds]);
  const generated = rule ? data.expenses.filter((e) => e.recurring_id === rule.id).sort((a, b) => b.date.localeCompare(a.date)) : [];
  const next = nextDate({ day_of_month: day, start_date: start, end_date: end || null, active }, today());

  const save = async () => {
    setErr('');
    if (!title.trim()) return setErr('Indiquez un titre.');
    if (!cents) return setErr('Montant invalide.');
    if (day < 1 || day > 31) return setErr('Jour du mois entre 1 et 31.');
    if (preview.error) return setErr(preview.error);
    if (end && end < start) return setErr('La date de fin précède la date de début.');
    const payload: Partial<RecurringExpense> = {
      title: title.trim(), amount_cents: cents, day_of_month: day, category_id: cat, paid_by: paidBy, split_mode: mode, split_inputs: inputs,
      start_date: start, end_date: end || null, auto_validate: auto, active, note: note.trim(),
    };
    const r = await run<unknown>(() => rule
      ? backend.update<RecurringExpense>('recurring_expenses', rule.id, payload, rule.version)
      : backend.insert<RecurringExpense>('recurring_expenses', { ...payload, household_id: data.household.id, created_by: meId }),
    { success: rule ? 'Dépense récurrente modifiée' : 'Dépense récurrente créée', tables: ['recurring_expenses'], key: 'recur' });
    if (r) onClose();
  };

  const remove = async () => {
    if (!rule) return;
    if (!(await confirm({ title: 'Supprimer cette dépense récurrente ?', message: 'Les dépenses déjà créées restent dans l’historique et les soldes. Plus aucune ne sera créée à l’avenir.', confirm: 'Supprimer', danger: true }))) return;
    const r = await run(() => backend.remove('recurring_expenses', rule.id), { success: 'Dépense récurrente supprimée', tables: ['recurring_expenses'] });
    if (r !== undefined) onClose();
  };

  const cur = data.household.currency;
  return (
    <Modal title={rule ? 'Dépense récurrente' : 'Nouvelle dépense récurrente'} onClose={onClose} wide footer={
      <>
        {rule && <button className="btn btn-danger" style={{ marginRight: 'auto' }} onClick={remove}>Supprimer</button>}
        <button className="btn" onClick={onClose}>Fermer</button>
        <button className="btn btn-primary" onClick={save} disabled={!!preview.error}>Enregistrer</button>
      </>
    }>
      <div className="form-grid">
        <Field label="Titre" className="full"><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ex. : loyer, box internet, électricité" maxLength={120} /></Field>
        <Field label={`Montant mensuel (${cur})`}><input className="input num" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0,00" aria-invalid={!!amount && !cents} /></Field>
        <Field label="Jour du mois" hint="Le 31 = dernier jour des mois plus courts">
          <select className="select" value={day} onChange={(e) => setDay(Number(e.target.value))}>
            {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>le {d}</option>)}
          </select>
        </Field>
        <Field label="Catégorie">
          <select className="select" value={cat ?? ''} onChange={(e) => setCat(e.target.value || null)}>
            {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label="Payé par"><PersonSelect value={paidBy} onChange={(v) => v && setPaidBy(v)} /></Field>
      </div>
      <div className="form-section">
        <h4>Partage</h4>
        <Seg value={mode} onChange={setMode} options={[{ value: 'equal', label: 'Parts égales' }, { value: 'percent', label: 'Pourcentage' }, { value: 'single', label: 'Une personne' }]} />
        {mode === 'percent' && (
          <div className="form-grid">
            {memberIds.map((m, i) => (
              <Field key={m} label={`${name(m)} (%)`}>
                <input className="input num" inputMode="decimal" value={pct[m]} onChange={(e) => {
                  const v = e.target.value, other = memberIds[1 - i], n = Number(v.replace(',', '.'));
                  setPct(other && Number.isFinite(n) && n >= 0 && n <= 100 ? { [m]: v, [other]: String(Math.round((100 - n) * 1000) / 1000) } : { ...pct, [m]: v });
                }} />
              </Field>
            ))}
          </div>
        )}
        {mode === 'single' && <Field label="Entièrement à la charge de"><PersonSelect value={single} onChange={(v) => v && setSingle(v)} /></Field>}
        {preview.error ? <div className="error-box">{preview.error}</div> : preview.shares.length > 0 && (
          <div className="small muted">Chaque mois : {preview.shares.map((s) => `${name(s.user_id)} ${formatMoney(s.share_cents, cur)}`).join(' · ')}</div>
        )}
      </div>
      <div className="form-section">
        <h4>Période</h4>
        <div className="form-grid">
          <Field label="À partir du"><input type="date" className="input" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
          <Field label="Jusqu’au (facultatif)"><input type="date" className="input" value={end} onChange={(e) => setEnd(e.target.value)} /></Field>
        </div>
        <label className="toggle"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />Valider automatiquement (sinon, créée comme « provisoire » à vérifier)</label>
        <label className="toggle"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />Active (décocher pour mettre en pause)</label>
        <Field label="Note (facultative)"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} /></Field>
        <div className="info-box small">{next ? `Prochaine création : ${fmtDate(next, { weekday: 'long', day: 'numeric', month: 'long' })}.` : 'Aucune prochaine création (en pause ou terminée).'} Les mois passés depuis le début sont rattrapés automatiquement à l’ouverture de l’application.</div>
      </div>
      {generated.length > 0 && (
        <details>
          <summary className="small strong" style={{ cursor: 'pointer' }}>Dépenses déjà créées ({generated.length})</summary>
          <ul className="timeline" style={{ marginTop: 8 }}>
            {generated.slice(0, 24).map((e) => <li key={e.id}><span className="muted nowrap">{fmtDate(e.date, { day: 'numeric', month: 'short', year: 'numeric' })}</span><span>{formatMoney(e.amount_cents, cur)}{e.status !== 'validated' ? ` · ${e.status === 'draft' ? 'provisoire' : 'annulée'}` : ''}</span></li>)}
          </ul>
        </details>
      )}
      {err && <div className="error-box">{err}</div>}
    </Modal>
  );
}
