import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { backend } from '../backend';
import { useData } from '../store';
import type { Effort, Expense, Frequency, Occurrence, RecurringExpense, Reimbursement, ShoppingItem, SplitMode, TaskTemplate, UUID } from '../types';
import { RecurringModal } from './RecurringModal';
import { GroupBadge } from './mobile';
import { groupColor, listGroups } from '../lib/groups';
import { Field, Icon, Modal, Person, PersonSelect, Seg, StatusBadge, useConfirm } from './ui';
import { addDays, fmtDate, fmtDateLong, fmtDateTime, today, WEEKDAYS_LONG, WEEKDAYS_SHORT } from '../lib/dates';
import { coefs, EFFORT_LABEL, fairnessStats, isOpen, makeIsLate, occurrenceFields, weightOf } from '../lib/fairness';
import { centsToInput, computeShares, formatMoney, parseCents, SplitError } from '../lib/money';
import { templateAppliesOn, describeFrequency, MONTH_WEEK_LABEL } from '../lib/recurrence';
import { cx, fmtMinutes, uuid } from '../lib/util';

interface ExpensePrefill {
  title?: string;
  amount_cents?: number;
  category_name?: string;
  maintenance_id?: UUID;
  date?: string;
  onSaved?: () => void;
}
interface Modals {
  openOccurrence: (id: UUID) => void;
  openTemplate: (tpl: TaskTemplate | null, defaults?: Partial<TaskTemplate>) => void;
  openExpense: (e: Expense | null, prefill?: ExpensePrefill) => void;
  openReimbursement: (prefill?: Partial<Reimbursement>, existing?: Reimbursement) => void;
  openShopping: (item: ShoppingItem | null, defaults?: Partial<ShoppingItem>) => void;
  openRecurring: (rule: RecurringExpense | null) => void;
}

const Ctx = createContext<Modals>(null!);
export const useModals = () => useContext(Ctx);

type State =
  | { kind: 'occ'; id: UUID }
  | { kind: 'tpl'; tpl: TaskTemplate | null; defaults?: Partial<TaskTemplate> }
  | { kind: 'exp'; e: Expense | null; prefill?: ExpensePrefill }
  | { kind: 'reimb'; prefill?: Partial<Reimbursement>; existing?: Reimbursement }
  | { kind: 'shop'; item: ShoppingItem | null; defaults?: Partial<ShoppingItem> }
  | { kind: 'recur'; rule: RecurringExpense | null }
  | null;

export function ModalsProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>(null);
  const api = useMemo<Modals>(() => ({
    openOccurrence: (id) => setState({ kind: 'occ', id }),
    openTemplate: (tpl, defaults) => setState({ kind: 'tpl', tpl, defaults }),
    openExpense: (e, prefill) => setState({ kind: 'exp', e, prefill }),
    openReimbursement: (prefill, existing) => setState({ kind: 'reimb', prefill, existing }),
    openShopping: (item, defaults) => setState({ kind: 'shop', item, defaults }),
    openRecurring: (rule) => setState({ kind: 'recur', rule }),
  }), []);
  const close = () => setState(null);
  return (
    <Ctx.Provider value={api}>
      {children}
      {state?.kind === 'occ' && <OccurrenceModal id={state.id} onClose={close} />}
      {state?.kind === 'tpl' && <TemplateModal tpl={state.tpl} defaults={state.defaults} onClose={close} />}
      {state?.kind === 'exp' && <ExpenseModal expense={state.e} prefill={state.prefill} onClose={close} />}
      {state?.kind === 'reimb' && <ReimbursementModal prefill={state.prefill} existing={state.existing} onClose={close} />}
      {state?.kind === 'shop' && <ShoppingModal item={state.item} defaults={state.defaults} onClose={close} />}
      {state?.kind === 'recur' && <RecurringModal rule={state.rule} onClose={close} />}
    </Ctx.Provider>
  );
}

/**
 * Supprimer une tâche : définitive si elle n'a jamais été réalisée,
 * sinon retirée du catalogue en gardant ses réalisations dans l'historique et l'équilibre.
 */
function useDeleteTemplate() {
  const { data, run } = useData();
  const confirm = useConfirm();
  return async (tpl: TaskTemplate): Promise<boolean> => {
    const done = data.task_occurrences.filter((o) => o.template_id === tpl.id && o.status === 'done').length;
    const ok = await confirm({
      title: `Supprimer « ${tpl.name} » ?`,
      message: done
        ? `Elle disparaîtra du catalogue et ne sera plus planifiée. ${done === 1 ? 'Sa réalisation reste' : `Ses ${done} réalisations restent`} dans l’historique et dans l’équilibre.`
        : 'Elle n’a jamais été réalisée : elle sera supprimée définitivement, avec ses occurrences à venir.',
      confirm: 'Supprimer', danger: true,
    });
    if (!ok) return false;
    const r = await run(() => backend.rpc<string>('delete_task_template', { p_id: tpl.id }), {
      success: done ? 'Tâche retirée du catalogue (historique conservé)' : 'Tâche supprimée',
      tables: ['task_templates', 'task_occurrences', 'swap_requests'], key: 'del-' + tpl.id,
    });
    return r !== undefined;
  };
}

// =====================================================================
// Détail d'une occurrence de tâche
// =====================================================================
function OccurrenceModal({ id, onClose }: { id: UUID; onClose: () => void }) {
  const { data, run, meId, otherId, name, zone } = useData();
  const confirm = useConfirm();
  const deleteTemplate = useDeleteTemplate();
  const o = data.task_occurrences.find((x) => x.id === id);
  const tpl = data.task_templates.find((t) => t.id === o?.template_id);
  const [panel, setPanel] = useState<'none' | 'done' | 'postpone' | 'swap' | 'problem'>('none');
  const [actual, setActual] = useState('');
  const [newDate, setNewDate] = useState(addDays(today(), 1));
  const [msg, setMsg] = useState('');
  const [comment, setComment] = useState('');
  if (!o) return <Modal title="Tâche introuvable" onClose={onClose}><p className="muted">Cette tâche n’existe plus.</p></Modal>;

  const late = makeIsLate(data.task_templates, today())(o);
  const pendingSwap = data.swap_requests.find((s) => s.occurrence_id === o.id && s.status === 'pending');
  const comments = data.comments.filter((c) => c.entity === 'occurrence' && c.entity_id === o.id).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const history = data.activity_log.filter((l) => l.entity === 'occurrence' && l.entity_id === o.id).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const swaps = data.swap_requests.filter((s) => s.occurrence_id === o.id && s.status !== 'pending');
  const z = zone(o.zone_id);
  const inProgressEnabled = !!data.household.settings.enable_in_progress;

  const upd = (patch: Partial<Occurrence>, success: string) =>
    run(() => backend.update<Occurrence>('task_occurrences', o.id, patch, o.version), { success, tables: ['task_occurrences'], key: 'occ-' + o.id });

  const markDone = async () => {
    const mins = actual.trim() ? Math.max(0, Math.round(Number(actual.replace(',', '.')))) : null;
    const r = await upd({ status: 'done', done_at: new Date().toISOString(), done_by: meId, actual_min: Number.isFinite(mins as number) ? mins : null }, 'Tâche terminée. Merci !');
    if (r) onClose();
  };

  const statusLabel = (v: unknown) => ({ todo: 'À faire', in_progress: 'En cours', done: 'Terminée', postponed: 'Reportée', cancelled: 'Annulée' } as Record<string, string>)[String(v)] ?? String(v);

  return (
    <Modal title={o.name} onClose={onClose} wide footer={
      <>
        {isOpen(o) && !o.proposed && (
          <>
            {inProgressEnabled && o.status !== 'in_progress' && <button className="btn" onClick={() => upd({ status: 'in_progress' }, 'Tâche en cours')}><Icon name="play" size={14} />Commencer</button>}
            <button className="btn btn-primary" onClick={() => setPanel(panel === 'done' ? 'none' : 'done')}><Icon name="check" />Marquer terminée</button>
          </>
        )}
        {(o.status === 'done' || o.status === 'cancelled') && (
          <button className="btn" onClick={() => upd({ status: 'todo', done_at: null, done_by: null }, 'Tâche rouverte')}><Icon name="undo" size={14} />Rouvrir</button>
        )}
      </>
    }>
      <div className="row-wrap">
        <StatusBadge status={o.status} late={late} proposed={o.proposed} />
        {tpl?.group_name && <GroupBadge name={tpl.group_name} color={groupColor(data, tpl.group_name)} />}
        {o.locked && <span className="badge"><Icon name="lock" size={12} />Attribution verrouillée</span>}
        {pendingSwap && <span className="badge warning"><Icon name="swap" size={12} />Échange en attente</span>}
        {o.problem && <span className="badge danger"><Icon name="alert" size={12} />Problème signalé</span>}
      </div>

      <dl className="kv">
        <dt>Date</dt>
        <dd>{fmtDateLong(o.due_date)}{o.due_date !== o.scheduled_date && <span className="muted"> (prévue le {fmtDate(o.scheduled_date)})</span>}</dd>
        <dt>Zone</dt><dd>{z ? `${z.icon} ${z.name}` : '—'}</dd>
        <dt>Attribuée à</dt><dd><Person id={o.assigned_to} /></dd>
        <dt>Durée estimée</dt><dd>{fmtMinutes(o.estimated_min)} · effort {EFFORT_LABEL[o.effort].toLowerCase()} · charge {Number(o.weight)}</dd>
        {o.status === 'done' && <><dt>Réalisée</dt><dd>{fmtDateTime(o.done_at)} par {name(o.done_by ?? o.assigned_to)}{o.actual_min != null && ` · ${fmtMinutes(o.actual_min)} réelles`}</dd></>}
        {tpl && <><dt>Récurrence</dt><dd>{describeFrequency(tpl)}</dd></>}
      </dl>

      {(tpl?.description || tpl?.instructions) && (
        <div className="stack-sm">
          {tpl.description && <p>{tpl.description}</p>}
          {tpl.instructions && <div className="info-box"><b>Consignes :</b> {tpl.instructions}</div>}
        </div>
      )}
      {o.problem && <div className="error-box"><b>Problème :</b> {o.problem}</div>}

      {panel === 'done' && (
        <div className="card card-pad stack" style={{ background: 'var(--surface-2)' }}>
          <Field label="Temps réellement passé (facultatif)" hint={`Estimation : ${o.estimated_min} min`}>
            <input className="input" inputMode="numeric" placeholder="minutes" value={actual} onChange={(e) => setActual(e.target.value)} />
          </Field>
          <button className="btn btn-primary" onClick={markDone}><Icon name="check" />Confirmer</button>
        </div>
      )}

      {/* Actions secondaires */}
      {isOpen(o) && (
        <div className="row-wrap">
          <button className={cx('btn btn-sm', panel === 'postpone' && 'btn-primary')} onClick={() => setPanel(panel === 'postpone' ? 'none' : 'postpone')}><Icon name="clock" size={14} />Reporter</button>
          {o.assigned_to === meId && otherId && !pendingSwap && !o.proposed && (
            <button className={cx('btn btn-sm', panel === 'swap' && 'btn-primary')} onClick={() => setPanel(panel === 'swap' ? 'none' : 'swap')}><Icon name="swap" size={14} />Demander un échange</button>
          )}
          <button className={cx('btn btn-sm', panel === 'problem' && 'btn-primary')} onClick={() => setPanel(panel === 'problem' ? 'none' : 'problem')}><Icon name="alert" size={14} />Signaler un problème</button>
          <button className="btn btn-sm" onClick={() => upd({ locked: !o.locked }, o.locked ? 'Attribution déverrouillée' : 'Attribution verrouillée')}>
            <Icon name={o.locked ? 'unlock' : 'lock'} size={14} />{o.locked ? 'Déverrouiller' : 'Verrouiller'}
          </button>
          <button className="btn btn-sm btn-danger" onClick={async () => {
            if (await confirm({ title: 'Annuler cette occurrence ?', message: 'Elle restera dans l’historique avec le statut « Annulée » et ne comptera pas dans la charge.', confirm: 'Annuler l’occurrence', danger: true })) {
              upd({ status: 'cancelled' }, 'Occurrence annulée');
            }
          }}><Icon name="x" size={14} />Annuler</button>
        </div>
      )}
      {tpl?.frequency === 'once' && (
        <div className="row-wrap">
          <button className="btn btn-sm btn-danger" onClick={async () => { if (await deleteTemplate(tpl)) onClose(); }}><Icon name="trash" size={14} />Supprimer cette tâche ponctuelle</button>
        </div>
      )}

      {isOpen(o) && (
        <Field label="Modifier l’attribution" hint="Une attribution manuelle est verrouillée : la répartition automatique ne la changera plus.">
          <PersonSelect value={o.assigned_to} allowNone onChange={(v) => upd({ assigned_to: v, locked: true }, 'Attribution modifiée')} />
        </Field>
      )}

      {panel === 'postpone' && (
        <div className="card card-pad row-wrap" style={{ background: 'var(--surface-2)' }}>
          <input type="date" className="input" style={{ width: 'auto' }} value={newDate} min={today()} onChange={(e) => setNewDate(e.target.value)} />
          <button className="btn btn-primary" onClick={async () => { if (await upd({ due_date: newDate, status: 'postponed' }, `Reportée au ${fmtDate(newDate)}`)) setPanel('none'); }}>Reporter</button>
        </div>
      )}
      {panel === 'swap' && otherId && (
        <div className="card card-pad stack" style={{ background: 'var(--surface-2)' }}>
          <Field label={`Message pour ${name(otherId)} (facultatif)`}>
            <input className="input" value={msg} onChange={(e) => setMsg(e.target.value)} maxLength={300} placeholder="Ex. : je rentre tard mardi, tu peux la prendre ?" />
          </Field>
          <p className="small muted">L’attribution ne change qu’après acceptation.</p>
          <button className="btn btn-primary" onClick={async () => {
            const r = await run(() => backend.insert('swap_requests', { household_id: o.household_id, occurrence_id: o.id, from_user: meId, to_user: otherId, message: msg.trim() }), { success: 'Demande envoyée', tables: ['swap_requests'], key: 'swap' });
            if (r) setPanel('none');
          }}>Envoyer la demande</button>
        </div>
      )}
      {panel === 'problem' && (
        <ProblemForm initial={o.problem ?? ''} onSave={async (p) => { if (await upd({ problem: p || null }, p ? 'Problème signalé' : 'Signalement retiré')) setPanel('none'); }} />
      )}

      {pendingSwap && (
        <div className="card card-pad stack-sm" style={{ background: 'var(--warning-soft)' }}>
          <div><b>{name(pendingSwap.from_user)}</b> demande à <b>{name(pendingSwap.to_user)}</b> de reprendre cette tâche.</div>
          {pendingSwap.message && <div className="small">« {pendingSwap.message} »</div>}
          <SwapActions swapId={pendingSwap.id} />
        </div>
      )}

      {/* Commentaires */}
      <div className="stack-sm">
        <h3>Commentaires</h3>
        {comments.length === 0 && <p className="small muted">Aucun commentaire.</p>}
        {comments.map((c) => (
          <div key={c.id} className="comment"><b>{name(c.user_id)}</b> <span className="xs muted">{fmtDateTime(c.created_at)}</span><div>{c.body}</div></div>
        ))}
        <form className="row" onSubmit={async (e) => {
          e.preventDefault();
          if (!comment.trim()) return;
          const r = await run(() => backend.insert('comments', { household_id: o.household_id, entity: 'occurrence', entity_id: o.id, user_id: meId, body: comment.trim() }), { tables: ['comments'], key: 'comment' });
          if (r) setComment('');
        }}>
          <input className="input" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Ajouter un commentaire…" maxLength={2000} />
          <button className="btn" aria-label="Envoyer"><Icon name="message" /></button>
        </form>
      </div>

      {(history.length > 0 || swaps.length > 0) && (
        <details>
          <summary className="small strong" style={{ cursor: 'pointer' }}>Historique</summary>
          <ul className="timeline" style={{ marginTop: 8 }}>
            {history.map((h) => (
              <li key={h.id}><span className="muted nowrap">{fmtDateTime(h.created_at)}</span>
                <span>{name(h.user_id)} — {h.action === 'reassign' ? `attribution : ${name(h.details.from as string)} → ${name(h.details.to as string)}` : h.action === 'status' ? `statut : ${statusLabel(h.details.from)} → ${statusLabel(h.details.to)}` : h.action === 'postpone' ? `reportée du ${fmtDate(h.details.from as string)} au ${fmtDate(h.details.to as string)}` : h.action}</span>
              </li>
            ))}
            {swaps.map((s) => <li key={s.id}><span className="muted nowrap">{fmtDateTime(s.responded_at ?? s.created_at)}</span><span>Échange {s.status === 'accepted' ? 'accepté' : s.status === 'refused' ? 'refusé' : 'annulé'} ({name(s.from_user)} → {name(s.to_user)})</span></li>)}
          </ul>
        </details>
      )}
    </Modal>
  );
}

function ProblemForm({ initial, onSave }: { initial: string; onSave: (p: string) => void }) {
  const [v, setV] = useState(initial);
  return (
    <div className="card card-pad stack" style={{ background: 'var(--surface-2)' }}>
      <Field label="Décrivez le problème" hint="Ex. : plus de produit, équipement en panne, tâche impossible aujourd’hui">
        <textarea className="textarea" value={v} onChange={(e) => setV(e.target.value)} maxLength={500} />
      </Field>
      <div className="row"><button className="btn btn-primary" onClick={() => onSave(v.trim())}>Enregistrer</button>{initial && <button className="btn" onClick={() => onSave('')}>Retirer le signalement</button>}</div>
    </div>
  );
}

export function SwapActions({ swapId }: { swapId: UUID }) {
  const { data, run, meId } = useData();
  const s = data.swap_requests.find((x) => x.id === swapId);
  if (!s || s.status !== 'pending') return null;
  if (s.to_user === meId) {
    return (
      <div className="row">
        <button className="btn btn-primary btn-sm" onClick={() => run(() => backend.rpc('respond_swap', { p_id: s.id, p_accept: true }), { success: 'Échange accepté : la tâche vous est attribuée', tables: ['swap_requests', 'task_occurrences'], key: 'resp-' + s.id })}>Accepter</button>
        <button className="btn btn-sm" onClick={() => run(() => backend.rpc('respond_swap', { p_id: s.id, p_accept: false }), { success: 'Échange refusé', tables: ['swap_requests'], key: 'resp-' + s.id })}>Refuser</button>
      </div>
    );
  }
  if (s.from_user === meId) {
    return <button className="btn btn-sm" onClick={() => run(() => backend.update('swap_requests', s.id, { status: 'cancelled' }), { success: 'Demande retirée', tables: ['swap_requests'] })}>Retirer ma demande</button>;
  }
  return null;
}

// =====================================================================
// Modèle de tâche (création / modification) et tâche ponctuelle
// =====================================================================
function TemplateModal({ tpl, defaults, onClose }: { tpl: TaskTemplate | null; defaults?: Partial<TaskTemplate>; onClose: () => void }) {
  const { data, run, memberIds, meId } = useData();
  const confirm = useConfirm();
  const zones = data.zones.filter((z) => z.active || z.id === tpl?.zone_id).sort((a, b) => a.position - b.position);
  const groups = listGroups(data).map((g) => g.name);
  const [f, setF] = useState<Partial<TaskTemplate>>(() => tpl ? { ...tpl } : {
    name: '', zone_id: zones[0]?.id ?? null, frequency: 'weekly', weekdays: [6], once_date: today(), duration_min: 15, effort: 'moderate',
    preferred_user: null, fixed_user: null, start_date: today(), end_date: null, description: '', instructions: '', window_days: 0, active: true, ...defaults,
  });
  const [assignOnce, setAssignOnce] = useState<UUID | 'auto'>('auto');
  const [updateFuture, setUpdateFuture] = useState(true);
  const [err, setErr] = useState('');
  const set = <K extends keyof TaskTemplate>(k: K, v: TaskTemplate[K]) => setF((x) => ({ ...x, [k]: v }));
  const c = coefs(data.household.settings);
  const weight = weightOf(Number(f.duration_min) || 0, (f.effort ?? 'moderate') as Effort, c);

  const save = async () => {
    setErr('');
    if (!f.name?.trim()) return setErr('Donnez un nom à la tâche.');
    if (!f.duration_min || f.duration_min < 1) return setErr('Indiquez une durée estimée.');
    if (f.frequency === 'weekly' && !f.weekdays?.length) return setErr('Choisissez au moins un jour.');
    if (f.frequency === 'once' && !f.once_date) return setErr('Choisissez une date.');
    if (f.end_date && f.start_date && f.end_date < f.start_date) return setErr('La date de fin précède la date de début.');
    const payload: Partial<TaskTemplate> = {
      name: f.name.trim(), zone_id: f.zone_id, frequency: f.frequency, weekdays: f.frequency === 'weekly' ? [...(f.weekdays ?? [])].sort() : f.frequency === 'monthly' ? [f.weekdays?.[0] ?? 6] : [],
      // group_name / month_week ne sont envoyés que si utiles (compatibilité avec une base sans les correctifs)
      ...(f.group_name?.trim() || (tpl && tpl.group_name != null) ? { group_name: f.group_name?.trim() || null } : {}),
      // month_week n'est envoyé que si utile (compatibilité avec une base sans le correctif n°2)
      ...(f.frequency === 'monthly' || (tpl && tpl.month_week != null) ? { month_week: f.frequency === 'monthly' ? f.month_week ?? 1 : null } : {}),
      once_date: f.frequency === 'once' ? f.once_date : null, duration_min: Number(f.duration_min), effort: f.effort, preferred_user: f.preferred_user || null,
      fixed_user: f.fixed_user || null, start_date: f.frequency === 'once' ? f.once_date! : f.start_date, end_date: f.frequency === 'once' ? null : f.end_date || null,
      description: f.description ?? '', instructions: f.instructions ?? '', window_days: Number(f.window_days) || 0, active: f.active ?? true,
    };
    const saved = await run(async () => {
      if (tpl) {
        const t = await backend.update<TaskTemplate>('task_templates', tpl.id, payload, tpl.version);
        if (updateFuture) {
          // Occurrences futures non terminées : mise à jour, ou annulation si elles ne correspondent plus au calendrier
          const future = data.task_occurrences.filter((o) => o.template_id === tpl.id && isOpen(o) && o.due_date >= today());
          for (const o of future) {
            const patch: Partial<Occurrence> = templateAppliesOn(t, o.scheduled_date) || o.due_date !== o.scheduled_date
              ? { name: t.name, zone_id: t.zone_id, estimated_min: t.duration_min, effort: t.effort, weight: weightOf(t.duration_min, t.effort, c) }
              : { status: 'cancelled' };
            await backend.update('task_occurrences', o.id, patch);
          }
        }
        return t;
      }
      const [t] = await backend.insert<TaskTemplate>('task_templates', { ...payload, household_id: data.household.id, created_by: meId });
      if (t.frequency === 'once') {
        let who: UUID | null = assignOnce === 'auto' ? null : assignOnce;
        if (!who) {
          const st = fairnessStats(data.task_occurrences, memberIds, addDays(today(), -28), addDays(today(), 14));
          who = [...memberIds].sort((a, b) => st.per[a].weighted - st.per[b].weighted)[0] ?? meId;
        }
        if (t.fixed_user) who = t.fixed_user;
        await backend.insert('task_occurrences', { ...occurrenceFields(t, t.once_date!, who, weightOf(t.duration_min, t.effort, c), false), locked: assignOnce !== 'auto' });
      }
      return t;
    }, { success: tpl ? 'Tâche modifiée' : 'Tâche créée', tables: ['task_templates', 'task_occurrences'], key: 'tpl' });
    if (saved) onClose();
  };

  const deleteTemplate = useDeleteTemplate();
  const archive = async () => {
    if (!tpl) return;
    if (await confirm({ title: 'Archiver cette tâche ?', message: 'Elle ne sera plus planifiée. Les occurrences passées restent dans l’historique ; les occurrences futures non terminées sont annulées.', confirm: 'Archiver', danger: true })) {
      const r = await run(async () => {
        await backend.update('task_templates', tpl.id, { archived: true, active: false }, tpl.version);
        for (const o of data.task_occurrences.filter((x) => x.template_id === tpl.id && isOpen(x) && x.due_date >= today())) {
          await backend.update('task_occurrences', o.id, { status: 'cancelled' });
        }
      }, { success: 'Tâche archivée', tables: ['task_templates', 'task_occurrences'] });
      if (r !== undefined) onClose();
    }
  };

  return (
    <Modal title={tpl ? 'Modifier la tâche' : f.frequency === 'once' ? 'Nouvelle tâche ponctuelle' : 'Nouvelle tâche'} onClose={onClose} wide footer={
      <>
        {tpl && <button className="btn btn-danger" style={{ marginRight: 'auto' }} onClick={async () => { if (await deleteTemplate(tpl)) onClose(); }}><Icon name="trash" size={14} />Supprimer</button>}
        {tpl && !tpl.archived && tpl.frequency !== 'once' && <button className="btn" onClick={archive}><Icon name="box" size={14} />Archiver</button>}
        {tpl?.archived && <button className="btn" style={{ marginRight: 'auto' }} onClick={() => run(() => backend.update('task_templates', tpl.id, { archived: false, active: true }, tpl.version), { success: 'Tâche réactivée', tables: ['task_templates'] }).then(onClose)}>Réactiver</button>}
        <button className="btn" onClick={onClose}>Annuler</button>
        <button className="btn btn-primary" onClick={save}>Enregistrer</button>
      </>
    }>
      <div className="form-section">
        <div className="form-grid">
          <Field label="Nom" className="full"><input className="input" value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="Ex. : nettoyer le lavabo" maxLength={100} /></Field>
          <Field label="Zone">
            <select className="select" value={f.zone_id ?? ''} onChange={(e) => set('zone_id', e.target.value || null)}>
              {zones.map((z) => <option key={z.id} value={z.id}>{z.icon} {z.name}</option>)}
            </select>
          </Field>
          <Field label="Fréquence">
            <Seg<Frequency> value={f.frequency as Frequency} onChange={(v) => set('frequency', v)} options={[{ value: 'daily', label: 'Quotidienne' }, { value: 'weekly', label: 'Hebdo' }, { value: 'monthly', label: 'Mensuelle' }, { value: 'once', label: 'Ponctuelle' }]} />
          </Field>
          {f.frequency === 'monthly' && (
            <Field label="Chaque mois" className="full" hint="Ex. : le 1er samedi du mois. « Dernier » = le dernier de ce jour dans le mois.">
              <div className="row">
                <select className="select" value={f.month_week ?? 1} onChange={(e) => set('month_week', Number(e.target.value))} aria-label="Semaine du mois">
                  {[1, 2, 3, 4, -1].map((n) => <option key={n} value={n}>{MONTH_WEEK_LABEL[String(n)]}</option>)}
                </select>
                <select className="select" value={f.weekdays?.[0] ?? 6} onChange={(e) => set('weekdays', [Number(e.target.value)])} aria-label="Jour">
                  {WEEKDAYS_LONG.map((d, i) => <option key={d} value={i + 1}>{d}</option>)}
                </select>
                <span className="nowrap muted">du mois</span>
              </div>
            </Field>
          )}
          {f.frequency === 'weekly' && (
            <Field label="Jours" className="full">
              <div className="days">
                {WEEKDAYS_SHORT.map((d, i) => {
                  const on = f.weekdays?.includes(i + 1);
                  return <button type="button" key={d} aria-pressed={on} onClick={() => set('weekdays', on ? f.weekdays!.filter((x) => x !== i + 1) : [...(f.weekdays ?? []), i + 1])}>{d}</button>;
                })}
              </div>
            </Field>
          )}
          {f.frequency === 'once' ? (
            <>
              <Field label="Date"><input type="date" className="input" value={f.once_date ?? ''} onChange={(e) => set('once_date', e.target.value)} /></Field>
              {!tpl && (
                <Field label="Attribuer à">
                  <select className="select" value={assignOnce} onChange={(e) => setAssignOnce(e.target.value as UUID)}>
                    <option value="auto">Automatique (charge la plus faible)</option>
                    {memberIds.map((m) => <option key={m} value={m}>{data.profiles.find((p) => p.id === m)?.display_name}</option>)}
                  </select>
                </Field>
              )}
            </>
          ) : (
            <>
              <Field label="Début"><input type="date" className="input" value={f.start_date ?? ''} onChange={(e) => set('start_date', e.target.value)} /></Field>
              <Field label="Fin (facultative)"><input type="date" className="input" value={f.end_date ?? ''} onChange={(e) => set('end_date', e.target.value || null)} /></Field>
            </>
          )}
        </div>
      </div>
      <div className="form-section">
        <h4>Charge</h4>
        <div className="form-grid">
          <Field label="Durée estimée (minutes)"><input className="input" type="number" min={1} max={600} value={f.duration_min ?? ''} onChange={(e) => set('duration_min', Number(e.target.value))} /></Field>
          <Field label="Effort">
            <Seg<Effort> value={f.effort as Effort} onChange={(v) => set('effort', v)} options={(['light', 'moderate', 'heavy'] as Effort[]).map((e) => ({ value: e, label: EFFORT_LABEL[e] }))} />
          </Field>
        </div>
        <p className="small muted">Charge pondérée : <b>{weight}</b> ({f.duration_min || 0} min × {c[(f.effort ?? 'moderate') as Effort]}).</p>
      </div>
      <div className="form-section">
        <h4>Attribution</h4>
        <div className="form-grid">
          <Field label="Groupe (facultatif)" className="full" hint="Même jour, même personne, même dans des pièces différentes. Créez ou modifiez les groupes (nom, couleur, tâches) dans Tâches → Catalogue → Groupes.">
            <select className="select" value={f.group_name ?? ''} onChange={(e) => set('group_name', e.target.value || null)}>
              <option value="">Aucun groupe</option>
              {groups.map((g) => <option key={g} value={g}>{g}</option>)}
              {f.group_name && !groups.includes(f.group_name) && <option value={f.group_name}>{f.group_name}</option>}
            </select>
          </Field>
          <Field label="Personne préférée" hint="Favorisée à charge proche"><PersonSelect value={f.preferred_user ?? null} allowNone noneLabel="Aucune" onChange={(v) => set('preferred_user', v)} /></Field>
          <Field label="Attribution fixe" hint="Toujours la même personne"><PersonSelect value={f.fixed_user ?? null} allowNone noneLabel="Non (répartition automatique)" onChange={(v) => set('fixed_user', v)} /></Field>
          {f.frequency !== 'once' && (
            <Field label="Plage de réalisation" hint="Nombre de jours de tolérance après la date prévue">
              <select className="select" value={f.window_days ?? 0} onChange={(e) => set('window_days', Number(e.target.value))}>
                {[0, 1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n === 0 ? 'Le jour même' : `Jusqu’à ${n} jour${n > 1 ? 's' : ''} après`}</option>)}
              </select>
            </Field>
          )}
          {tpl && f.frequency !== 'once' && (
            <Field label="État">
              <label className="toggle"><input type="checkbox" checked={f.active ?? true} onChange={(e) => set('active', e.target.checked)} />Active (décocher pour suspendre)</label>
            </Field>
          )}
        </div>
      </div>
      <div className="form-section">
        <h4>Détails</h4>
        <Field label="Description (étapes, résultat attendu)"><textarea className="textarea" value={f.description} onChange={(e) => set('description', e.target.value)} maxLength={1000} /></Field>
        <Field label="Consignes (matériel, produits, précautions)"><textarea className="textarea" value={f.instructions} onChange={(e) => set('instructions', e.target.value)} maxLength={1000} /></Field>
      </div>
      {tpl && (
        <label className="toggle"><input type="checkbox" checked={updateFuture} onChange={(e) => setUpdateFuture(e.target.checked)} />Appliquer aux occurrences futures non terminées (l’historique passé n’est jamais modifié)</label>
      )}
      {err && <div className="error-box">{err}</div>}
    </Modal>
  );
}

// =====================================================================
// Dépense
// =====================================================================
function ExpenseModal({ expense, prefill, onClose }: { expense: Expense | null; prefill?: ExpensePrefill; onClose: () => void }) {
  const { data, run, memberIds, meId, name, category } = useData();
  const confirm = useConfirm();
  const cats = data.categories.filter((c) => c.kind === 'expense' && (!c.archived || c.id === expense?.category_id)).sort((a, b) => a.position - b.position);
  const existingShares = expense ? data.expense_shares.filter((s) => s.expense_id === expense.id) : [];
  const [clientKey] = useState(() => expense?.client_key ?? uuid());
  const [title, setTitle] = useState(expense?.title ?? prefill?.title ?? '');
  const [amount, setAmount] = useState(expense ? centsToInput(expense.amount_cents) : prefill?.amount_cents ? centsToInput(prefill.amount_cents) : '');
  const [date, setDate] = useState(expense?.date ?? prefill?.date ?? today());
  const [cat, setCat] = useState<UUID | null>(expense?.category_id ?? cats.find((c) => c.name === prefill?.category_name)?.id ?? cats[0]?.id ?? null);
  const [paidBy, setPaidBy] = useState<UUID>(expense?.paid_by ?? meId);
  const [mode, setMode] = useState<SplitMode>(expense?.split_mode ?? data.household.settings.default_split ?? 'equal');
  const [included, setIncluded] = useState<Record<UUID, boolean>>(() => Object.fromEntries(memberIds.map((m) => [m, expense ? existingShares.some((s) => s.user_id === m && s.share_cents > 0) : true])));
  const [pct, setPct] = useState<Record<UUID, string>>(() => Object.fromEntries(memberIds.map((m, i) => [m, String(existingShares.find((s) => s.user_id === m)?.percent ?? (i === 0 ? 50 : 50))])));
  const [fixed, setFixed] = useState<Record<UUID, string>>(() => Object.fromEntries(memberIds.map((m) => [m, existingShares.find((s) => s.user_id === m) ? centsToInput(existingShares.find((s) => s.user_id === m)!.share_cents) : ''])));
  const [single, setSingle] = useState<UUID>(() => (expense?.split_mode === 'single' ? existingShares[0]?.user_id : null) ?? memberIds.find((m) => m !== meId) ?? meId);
  const [note, setNote] = useState(expense?.note ?? '');
  const [draft, setDraft] = useState(expense?.status === 'draft');
  const [repeat, setRepeat] = useState(false);
  const [maint, setMaint] = useState<UUID | null>(expense?.maintenance_id ?? prefill?.maintenance_id ?? null);
  const [err, setErr] = useState('');

  const cents = parseCents(amount);
  const preview = useMemo(() => {
    if (!cents) return { error: amount ? 'Montant invalide.' : '', shares: [] as ReturnType<typeof computeShares> };
    try {
      const inputs = mode === 'single' ? [{ user_id: single }]
        : mode === 'percent' ? memberIds.map((m) => ({ user_id: m, value: Number(pct[m]?.replace(',', '.') || 0) }))
        : mode === 'fixed' ? memberIds.map((m) => ({ user_id: m, value: parseCents(fixed[m] || '0') ?? -1 }))
        : memberIds.map((m) => ({ user_id: m, included: included[m] }));
      return { error: '', shares: computeShares(cents, mode, inputs), inputs };
    } catch (e) {
      return { error: e instanceof SplitError ? e.message : 'Répartition invalide.', shares: [], inputs: [] };
    }
  }, [cents, amount, mode, single, pct, fixed, included, memberIds]);

  const history = expense ? data.activity_log.filter((l) => l.entity === 'expense' && l.entity_id === expense.id).sort((a, b) => a.created_at.localeCompare(b.created_at)) : [];
  const usedInReimb = expense && data.reimbursements.some((r) => r.status === 'done' && r.date >= expense.date);

  const save = async () => {
    setErr('');
    if (!title.trim()) return setErr('Indiquez un titre.');
    if (!cents) return setErr('Indiquez un montant valide (ex. : 12,50).');
    if (preview.error) return setErr(preview.error);
    const r = await run(async () => {
      // « Répéter tous les mois » : on crée la règle, puis la dépense de ce mois rattachée à la règle
      let recurringId = expense?.recurring_id ?? null;
      if (!expense && repeat) {
        const [rule] = await backend.insert<RecurringExpense>('recurring_expenses', {
          household_id: data.household.id, title: title.trim(), amount_cents: cents, category_id: cat, paid_by: paidBy, split_mode: mode,
          split_inputs: preview.inputs ?? [], day_of_month: Number(date.slice(8)), start_date: date, last_generated: date,
          auto_validate: !draft, active: true, note: note.trim(), created_by: meId,
        });
        recurringId = rule.id;
      }
      return backend.rpc('save_expense', {
        p_id: expense?.id ?? null, p_client_key: clientKey, p_version: expense?.version ?? null, p_title: title.trim(), p_amount_cents: cents, p_date: date,
        p_category_id: cat, p_paid_by: paidBy, p_split_mode: mode, p_status: draft ? 'draft' : 'validated', p_note: note.trim(), p_maintenance_id: maint,
        p_shares: preview.shares.filter((s) => s.share_cents > 0 || mode !== 'equal'), p_recurring_id: recurringId,
      });
    }, { success: expense ? 'Dépense modifiée' : repeat ? 'Dépense ajoutée et répétée chaque mois' : 'Dépense ajoutée', tables: ['expenses', 'expense_shares', 'recurring_expenses'], key: 'exp-' + clientKey });
    if (r) {
      prefill?.onSaved?.();
      onClose();
    }
  };

  const setStatus = async (status: Expense['status']) => {
    if (!expense) return;
    if (status === 'cancelled' && !(await confirm({ title: 'Annuler cette dépense ?', message: 'Elle restera visible dans l’historique mais ne comptera plus dans les soldes ni les budgets.', confirm: 'Annuler la dépense', danger: true }))) return;
    const r = await run(() => backend.rpc('set_expense_status', { p_id: expense.id, p_status: status, p_version: expense.version }), { success: status === 'cancelled' ? 'Dépense annulée' : status === 'validated' ? 'Dépense validée' : 'Dépense rétablie', tables: ['expenses'] });
    if (r !== undefined) onClose();
  };

  const describe = (d: Record<string, unknown> | undefined) => {
    if (!d) return '';
    const b = d.before as Partial<Expense> | undefined;
    const a = d.after as Partial<Expense> | undefined;
    if (!b || !a) return d.amount_cents ? `création (${formatMoney(Number(d.amount_cents), data.household.currency)})` : 'création';
    const ch: string[] = [];
    if (b.amount_cents !== a.amount_cents) ch.push(`montant ${formatMoney(b.amount_cents!)} → ${formatMoney(a.amount_cents!)}`);
    if (b.title !== a.title) ch.push(`titre « ${b.title} » → « ${a.title} »`);
    if (b.paid_by !== a.paid_by) ch.push(`payé par ${name(b.paid_by)} → ${name(a.paid_by)}`);
    if (b.split_mode !== a.split_mode) ch.push('mode de partage');
    if (b.status !== a.status) ch.push(`statut ${b.status} → ${a.status}`);
    if (b.date !== a.date) ch.push(`date ${fmtDate(b.date)} → ${fmtDate(a.date)}`);
    if (b.category_id !== a.category_id) ch.push(`catégorie → ${category(a.category_id)?.name ?? '—'}`);
    return ch.join(', ') || 'parts ou note modifiées';
  };

  const readOnly = expense?.status === 'cancelled';
  const currency = data.household.currency;

  return (
    <Modal title={expense ? (readOnly ? 'Dépense annulée' : 'Modifier la dépense') : 'Nouvelle dépense'} onClose={onClose} wide footer={
      readOnly ? (
        <><button className="btn" onClick={() => setStatus('validated')}><Icon name="undo" size={14} />Rétablir</button><button className="btn btn-primary" onClick={onClose}>Fermer</button></>
      ) : (
        <>
          {expense && <button className="btn btn-danger" style={{ marginRight: 'auto' }} onClick={() => setStatus('cancelled')}>Annuler la dépense</button>}
          <button className="btn" onClick={onClose}>Fermer</button>
          <button className="btn btn-primary" onClick={save} disabled={!!preview.error || !cents}>{expense ? 'Enregistrer' : 'Ajouter'}</button>
        </>
      )
    }>
      <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div className="form-section">
          <div className="form-grid">
            <Field label="Titre" className="full"><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ex. : courses de la semaine" maxLength={120} /></Field>
            <Field label={`Montant (${currency})`}><input className="input num" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0,00" aria-invalid={!!amount && !cents} /></Field>
            <Field label="Date"><input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
            <Field label="Catégorie">
              <select className="select" value={cat ?? ''} onChange={(e) => setCat(e.target.value || null)}>
                {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
            <Field label="Payé par"><PersonSelect value={paidBy} onChange={(v) => v && setPaidBy(v)} /></Field>
          </div>
        </div>
        <div className="form-section">
          <h4>Partage</h4>
          <Seg<SplitMode> value={mode} onChange={setMode} label="Mode de partage" options={[{ value: 'equal', label: 'Parts égales' }, { value: 'percent', label: 'Pourcentage' }, { value: 'fixed', label: 'Montants' }, { value: 'single', label: 'Une personne' }]} />
          {mode === 'equal' && (
            <div className="row-wrap">
              {memberIds.map((m) => <label key={m} className="toggle"><input type="checkbox" checked={!!included[m]} onChange={(e) => setIncluded({ ...included, [m]: e.target.checked })} />{name(m)}</label>)}
            </div>
          )}
          {mode === 'percent' && (
            <div className="form-grid">
              {memberIds.map((m, i) => (
                <Field key={m} label={`${name(m)} (%)`}>
                  <input className="input num" inputMode="decimal" value={pct[m]} onChange={(e) => {
                    const v = e.target.value;
                    const other = memberIds[1 - i];
                    const n = Number(v.replace(',', '.'));
                    setPct(other && Number.isFinite(n) && n >= 0 && n <= 100 ? { [m]: v, [other]: String(Math.round((100 - n) * 1000) / 1000) } : { ...pct, [m]: v });
                  }} />
                </Field>
              ))}
            </div>
          )}
          {mode === 'fixed' && (
            <div className="form-grid">
              {memberIds.map((m, i) => (
                <Field key={m} label={`Part de ${name(m)}`}>
                  <input className="input num" inputMode="decimal" value={fixed[m]} onChange={(e) => {
                    const v = e.target.value;
                    const other = memberIds[1 - i];
                    const c = parseCents(v);
                    setFixed(other && cents && c !== null && c <= cents ? { [m]: v, [other]: centsToInput(cents - c) } : { ...fixed, [m]: v });
                  }} />
                </Field>
              ))}
            </div>
          )}
          {mode === 'single' && (
            <Field label="Entièrement à la charge de"><PersonSelect value={single} onChange={(v) => v && setSingle(v)} /></Field>
          )}
          {preview.error ? (
            amount && <div className="error-box">{preview.error}</div>
          ) : preview.shares.length > 0 && cents ? (
            <div className="card card-pad stack-sm" style={{ background: 'var(--surface-2)' }}>
              {memberIds.map((m) => {
                const s = preview.shares.find((x) => x.user_id === m)?.share_cents ?? 0;
                return <div key={m} className="row between small"><Person id={m} /><span className="num strong">{formatMoney(s, currency)}</span></div>;
              })}
              {(() => {
                const debtor = memberIds.find((m) => m !== paidBy);
                const owed = preview.shares.find((x) => x.user_id === debtor)?.share_cents ?? 0;
                return debtor && owed > 0 ? <div className="small" style={{ borderTop: '1px solid var(--border)', paddingTop: 6 }}>→ <b>{name(debtor)}</b> devra <b>{formatMoney(owed, currency)}</b> à <b>{name(paidBy)}</b></div> : null;
              })()}
            </div>
          ) : null}
        </div>
        <div className="form-section">
          <h4>Compléments</h4>
          <div className="form-grid">
            <Field label="Note" className="full"><textarea className="textarea" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} /></Field>
            <Field label="Fiche d’entretien liée">
              <select className="select" value={maint ?? ''} onChange={(e) => setMaint(e.target.value || null)}>
                <option value="">Aucune</option>
                {data.maintenance.map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}
              </select>
            </Field>
            <Field label="Statut">
              <label className="toggle"><input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} />Provisoire (non comptée dans les soldes)</label>
            </Field>
            <Field label="Récurrence" className="full" hint={expense?.recurring_id ? 'Cette dépense provient d’une dépense récurrente (Budget → Récurrentes).' : repeat ? `Créée automatiquement le ${Number(date.slice(8))} de chaque mois (ou le dernier jour du mois), avec le même partage.` : undefined}>
              {expense ? <span className="small">{expense.recurring_id ? '🔁 Dépense récurrente' : 'Ponctuelle'}</span>
                : <label className="toggle"><input type="checkbox" checked={repeat} onChange={(e) => setRepeat(e.target.checked)} />Répéter tous les mois (loyer, abonnements…)</label>}
            </Field>
          </div>
        </div>
      </fieldset>
      {usedInReimb && !readOnly && <div className="info-box small">Des remboursements ont été enregistrés après cette dépense : la modifier changera le solde actuel. En cas d’erreur ancienne, préférez l’annuler et en saisir une nouvelle.</div>}
      {err && <div className="error-box">{err}</div>}
      {history.length > 0 && (
        <details>
          <summary className="small strong" style={{ cursor: 'pointer' }}>Historique des modifications ({history.length})</summary>
          <ul className="timeline" style={{ marginTop: 8 }}>
            {history.map((h) => <li key={h.id}><span className="muted nowrap">{fmtDateTime(h.created_at)}</span><span>{name(h.user_id)} — {describe(h.details)}</span></li>)}
          </ul>
        </details>
      )}
    </Modal>
  );
}

// =====================================================================
// Remboursement
// =====================================================================
function ReimbursementModal({ prefill, existing, onClose }: { prefill?: Partial<Reimbursement>; existing?: Reimbursement; onClose: () => void }) {
  const { data, run, meId, otherId } = useData();
  const confirm = useConfirm();
  const [clientKey] = useState(() => uuid());
  const [from, setFrom] = useState<UUID>(existing?.from_user ?? prefill?.from_user ?? meId);
  const [to, setTo] = useState<UUID>(existing?.to_user ?? prefill?.to_user ?? otherId ?? meId);
  const [amount, setAmount] = useState(existing ? centsToInput(existing.amount_cents) : prefill?.amount_cents ? centsToInput(prefill.amount_cents) : '');
  const [date, setDate] = useState(existing?.date ?? prefill?.date ?? today());
  const [note, setNote] = useState(existing?.note ?? prefill?.note ?? '');
  const [status, setStatus] = useState<Reimbursement['status']>(existing?.status ?? prefill?.status ?? 'done');
  const [err, setErr] = useState('');
  const cents = parseCents(amount);

  const save = async () => {
    setErr('');
    if (!cents) return setErr('Montant invalide.');
    if (from === to) return setErr('Choisissez deux personnes différentes.');
    const r = await run<unknown>(() => existing
      ? backend.update('reimbursements', existing.id, { from_user: from, to_user: to, amount_cents: cents, date, note: note.trim(), status }, existing.version)
      : backend.insert('reimbursements', { household_id: data.household.id, client_key: clientKey, from_user: from, to_user: to, amount_cents: cents, date, note: note.trim(), status, created_by: meId }),
    { success: existing ? 'Remboursement modifié' : status === 'done' ? 'Remboursement enregistré' : 'Remboursement prévu', tables: ['reimbursements'], key: 'reimb-' + clientKey });
    if (r) onClose();
  };

  return (
    <Modal title={existing ? 'Remboursement' : 'Enregistrer un remboursement'} onClose={onClose} footer={
      <>
        {existing && existing.status !== 'cancelled' && <button className="btn btn-danger" style={{ marginRight: 'auto' }} onClick={async () => {
          if (await confirm({ title: 'Annuler ce remboursement ?', message: 'Il ne sera plus pris en compte dans le solde.', danger: true, confirm: 'Annuler le remboursement' })) {
            const r = await run(() => backend.update('reimbursements', existing.id, { status: 'cancelled' }, existing.version), { success: 'Remboursement annulé', tables: ['reimbursements'] });
            if (r) onClose();
          }
        }}>Annuler le remboursement</button>}
        <button className="btn" onClick={onClose}>Fermer</button>
        <button className="btn btn-primary" onClick={save}>Enregistrer</button>
      </>
    }>
      <div className="form-grid">
        <Field label="Qui paie"><PersonSelect value={from} onChange={(v) => v && setFrom(v)} /></Field>
        <Field label="Qui reçoit"><PersonSelect value={to} onChange={(v) => v && setTo(v)} /></Field>
        <Field label={`Montant (${data.household.currency})`}><input className="input num" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-invalid={!!amount && !cents} /></Field>
        <Field label="Date"><input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Statut" className="full">
          <Seg value={status} onChange={setStatus} options={[{ value: 'done', label: 'Effectué' }, { value: 'planned', label: 'Prévu' }, ...(existing ? [{ value: 'cancelled' as const, label: 'Annulé' }] : [])]} />
        </Field>
        <Field label="Commentaire (facultatif)" className="full"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} /></Field>
      </div>
      <p className="small muted">Un remboursement modifie le solde entre vous deux mais n’est jamais compté comme une dépense commune. Seuls les remboursements effectués comptent.</p>
      {err && <div className="error-box">{err}</div>}
    </Modal>
  );
}

// =====================================================================
// Article de courses
// =====================================================================
function ShoppingModal({ item, defaults, onClose }: { item: ShoppingItem | null; defaults?: Partial<ShoppingItem>; onClose: () => void }) {
  const { data, run, meId } = useData();
  const cats = data.categories.filter((c) => c.kind === 'shopping' && !c.archived).sort((a, b) => a.position - b.position);
  const [f, setF] = useState<Partial<ShoppingItem>>(() => item ? { ...item } : { name: '', quantity: 1, unit: '', category: cats[0]?.name ?? 'Autres', priority: 'normal', assigned_to: null, note: '', price_estimate_cents: null, ...defaults });
  const [price, setPrice] = useState(f.price_estimate_cents ? centsToInput(f.price_estimate_cents) : '');
  const [err, setErr] = useState('');
  const set = <K extends keyof ShoppingItem>(k: K, v: ShoppingItem[K]) => setF((x) => ({ ...x, [k]: v }));

  const save = async (again = false) => {
    setErr('');
    if (!f.name?.trim()) return setErr('Indiquez un nom.');
    const p = price.trim() ? parseCents(price) : null;
    if (price.trim() && p === null) return setErr('Prix invalide.');
    const payload = { name: f.name.trim(), quantity: Number(f.quantity) > 0 ? Number(f.quantity) : 1, unit: f.unit ?? '', category: f.category ?? 'Autres', priority: f.priority ?? 'normal', assigned_to: f.assigned_to ?? null, note: f.note ?? '', price_estimate_cents: p, stock_id: f.stock_id ?? null };
    const r = await run<unknown>(() => item
      ? backend.update('shopping_items', item.id, payload, item.version)
      : backend.insert('shopping_items', { ...payload, household_id: data.household.id, created_by: meId }),
    { success: item ? 'Article modifié' : 'Ajouté à la liste', tables: ['shopping_items'], key: 'shop' });
    if (!r) return;
    if (again) {
      setF((x) => ({ ...x, name: '', quantity: 1, note: '', unit: '' }));
      setPrice('');
    } else onClose();
  };

  return (
    <Modal title={item ? 'Modifier l’article' : 'Ajouter aux courses'} onClose={onClose} footer={
      <>
        {item && <button className="btn btn-danger" style={{ marginRight: 'auto' }} onClick={async () => { if (await run(() => backend.update('shopping_items', item.id, { status: 'deleted' }, item.version), { success: 'Article retiré', tables: ['shopping_items'] })) onClose(); }}>Retirer</button>}
        <button className="btn" onClick={onClose}>Fermer</button>
        {!item && <button className="btn" onClick={() => save(true)}>Ajouter et continuer</button>}
        <button className="btn btn-primary" onClick={() => save()}>{item ? 'Enregistrer' : 'Ajouter'}</button>
      </>
    }>
      <form className="form-grid" onSubmit={(e) => { e.preventDefault(); save(); }}>
        <Field label="Article" className="full"><input className="input" value={f.name} onChange={(e) => set('name', e.target.value)} maxLength={120} placeholder="Ex. : liquide vaisselle" /></Field>
        <Field label="Quantité"><input className="input" type="number" min={0.01} step="any" value={f.quantity} onChange={(e) => set('quantity', Number(e.target.value))} /></Field>
        <Field label="Unité (facultative)"><input className="input" value={f.unit} onChange={(e) => set('unit', e.target.value)} placeholder="kg, L, paquet…" maxLength={20} /></Field>
        <Field label="Catégorie">
          <select className="select" value={f.category} onChange={(e) => set('category', e.target.value)}>
            {cats.map((c) => <option key={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label="Priorité">
          <Seg value={f.priority as ShoppingItem['priority']} onChange={(v) => set('priority', v)} options={[{ value: 'low', label: 'Basse' }, { value: 'normal', label: 'Normale' }, { value: 'high', label: 'Urgente' }]} />
        </Field>
        <Field label="Qui achète"><PersonSelect value={f.assigned_to ?? null} allowNone noneLabel="Indifférent" onChange={(v) => set('assigned_to', v)} /></Field>
        <Field label="Prix estimé (facultatif)"><input className="input num" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0,00" /></Field>
        <Field label="Note" className="full"><input className="input" value={f.note} onChange={(e) => set('note', e.target.value)} maxLength={300} /></Field>
        <button type="submit" hidden />
      </form>
      {err && <div className="error-box">{err}</div>}
    </Modal>
  );
}
