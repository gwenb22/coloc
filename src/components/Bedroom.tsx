import { useState } from 'react';
import { backend } from '../backend';
import { useData } from '../store';
import type { PrivateTask } from '../types';
import { Field, Icon, Modal, Seg, useConfirm } from './ui';
import { Beige, MRow, SectionTitle } from './mobile';
import { addDays, fmtDate, fmtDateTime, relativeDay, today } from '../lib/dates';
import { nextDue } from '../lib/recurring';

// « Ma chambre » : tâches privées. Visibles uniquement par leur autrice (règle RLS côté base)
// et jamais comptées dans la répartition ni dans l'équilibre.

const REPEAT_LABEL = { none: '', weekly: 'chaque semaine', monthly: 'chaque mois' } as const;

/** Cocher : une tâche répétée est reportée à sa prochaine échéance, sinon elle est terminée. */
export function usePrivateToggle() {
  const { run } = useData();
  return (t: PrivateTask) => {
    if (t.done) return run(() => backend.update('private_tasks', t.id, { done: false, done_at: null }, t.version), { success: 'Tâche rouverte', tables: ['private_tasks'], key: 'priv-' + t.id });
    if (t.repeat !== 'none' && t.due_date) {
      const n = nextDue(t, today())!;
      return run(() => backend.update('private_tasks', t.id, { due_date: n, done_at: new Date().toISOString() }, t.version), { success: `C’est fait ! Prochaine fois : ${fmtDate(n, { weekday: 'long', day: 'numeric', month: 'short' })}`, tables: ['private_tasks'], key: 'priv-' + t.id });
    }
    return run(() => backend.update('private_tasks', t.id, { done: true, done_at: new Date().toISOString() }, t.version), { success: 'C’est fait !', tables: ['private_tasks'], key: 'priv-' + t.id });
  };
}

export function PrivateRow({ t, onOpen }: { t: PrivateTask; onOpen: (t: PrivateTask) => void }) {
  const toggle = usePrivateToggle();
  const late = !t.done && !!t.due_date && t.due_date < today();
  const over = [
    t.done ? `fait ${fmtDateTime(t.done_at)}` : t.due_date ? (late ? `en retard · ${relativeDay(t.due_date)}` : relativeDay(t.due_date)) : 'sans date',
    REPEAT_LABEL[t.repeat],
    t.note,
  ].filter(Boolean).join(' · ');
  return (
    <MRow over={over} title={t.title} done={t.done} late={late} onClick={() => onOpen(t)}
      check={{ done: t.done, onToggle: () => toggle(t), label: t.done ? `Rouvrir ${t.title}` : `Terminer ${t.title}` }} />
  );
}

export function PrivateTaskModal({ task, defaultDate, onClose }: { task: PrivateTask | null; defaultDate?: string | null; onClose: () => void }) {
  const { data, run, meId } = useData();
  const confirm = useConfirm();
  const toggle = usePrivateToggle();
  const [title, setTitle] = useState(task?.title ?? '');
  const [note, setNote] = useState(task?.note ?? '');
  const [date, setDate] = useState(task?.due_date ?? defaultDate ?? '');
  const [repeat, setRepeat] = useState<PrivateTask['repeat']>(task?.repeat ?? 'none');
  const [err, setErr] = useState('');

  const save = async () => {
    setErr('');
    if (!title.trim()) return setErr('Indiquez ce qu’il y a à faire.');
    if (repeat !== 'none' && !date) return setErr('Choisissez une date pour une tâche qui se répète.');
    const payload = { title: title.trim(), note: note.trim(), due_date: date || null, repeat };
    const r = await run<unknown>(() => task
      ? backend.update('private_tasks', task.id, payload, task.version)
      : backend.insert('private_tasks', { ...payload, household_id: data.household.id, user_id: meId }),
    { success: task ? 'Tâche modifiée' : 'Ajoutée à ta chambre', tables: ['private_tasks'], key: 'priv-save' });
    if (r) onClose();
  };
  const remove = async () => {
    if (!task || !(await confirm({ title: 'Supprimer cette tâche ?', confirm: 'Supprimer', danger: true }))) return;
    const r = await run(() => backend.remove('private_tasks', task.id), { success: 'Tâche supprimée', tables: ['private_tasks'] });
    if (r !== undefined) onClose();
  };

  return (
    <Modal title={task ? 'Ma chambre · tâche' : 'Ma chambre · nouvelle tâche'} onClose={onClose} footer={
      <>
        {task && <button className="btn btn-danger" style={{ marginRight: 'auto' }} onClick={remove}>Supprimer</button>}
        {task && <button className="btn" onClick={async () => { if (await toggle(task)) onClose(); }}><Icon name={task.done ? 'undo' : 'check'} size={15} />{task.done ? 'Rouvrir' : 'C’est fait'}</button>}
        <button className="btn" onClick={onClose}>Annuler</button>
        <button className="btn btn-primary" onClick={save}>Enregistrer</button>
      </>
    }>
      <div className="private-note"><Icon name="lock" size={14} />Visible uniquement par toi · n’entre pas dans la répartition</div>
      <Field label="À faire"><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ex. : changer les draps, ranger le bureau" maxLength={120} /></Field>
      <div className="form-grid">
        <Field label="Quand (facultatif)"><input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Répéter">
          <Seg value={repeat} onChange={setRepeat} options={[{ value: 'none', label: 'Non' }, { value: 'weekly', label: 'Semaine' }, { value: 'monthly', label: 'Mois' }]} />
        </Field>
      </div>
      <Field label="Note (facultative)"><textarea className="textarea" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} /></Field>
      {err && <div className="error-box">{err}</div>}
    </Modal>
  );
}

/** Onglet « Ma chambre ». */
export function Bedroom() {
  const { data, run, meId } = useData();
  const [open, setOpen] = useState<PrivateTask | null | 'new'>(null);
  const [quick, setQuick] = useState('');
  const [when, setWhen] = useState<'none' | 'today' | 'tomorrow' | 'weekend'>('none');
  const t = today();
  const mine = data.private_tasks ?? [];
  const todo = mine.filter((x) => !x.done);
  const late = todo.filter((x) => x.due_date && x.due_date < t).sort((a, b) => a.due_date!.localeCompare(b.due_date!));
  const now = todo.filter((x) => x.due_date === t);
  const soon = todo.filter((x) => x.due_date && x.due_date > t).sort((a, b) => a.due_date!.localeCompare(b.due_date!));
  const undated = todo.filter((x) => !x.due_date);
  const done = mine.filter((x) => x.done).sort((a, b) => (b.done_at ?? '').localeCompare(a.done_at ?? '')).slice(0, 10);

  const quickDate = () => {
    if (when === 'today') return t;
    if (when === 'tomorrow') return addDays(t, 1);
    if (when === 'weekend') { const wd = new Date(t + 'T12:00').getDay(); return addDays(t, wd === 6 ? 0 : wd === 0 ? 0 : 6 - wd); }
    return null;
  };
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!quick.trim()) return;
    const r = await run(() => backend.insert('private_tasks', { household_id: data.household.id, user_id: meId, title: quick.trim(), due_date: quickDate() }), { tables: ['private_tasks'], key: 'priv-quick' });
    if (r) setQuick('');
  };
  const block = (title: string, list: PrivateTask[]) => list.length > 0 && (
    <Beige title={title}>{list.map((x) => <PrivateRow key={x.id} t={x} onOpen={setOpen} />)}</Beige>
  );

  return (
    <>
      <div className="private-note"><Icon name="lock" size={14} />Ta chambre est privée : ta colocataire ne voit pas ces tâches, et elles ne comptent pas dans l’équilibre.</div>
      <div className="mgrid">
        <div className="mcol">
          <form className="stack-sm" onSubmit={add}>
            <div className="row">
              <input className="input" style={{ borderRadius: 999, background: 'var(--surface-2)', borderColor: 'transparent' }} value={quick} onChange={(e) => setQuick(e.target.value)} placeholder="Ajouter… (Entrée)" aria-label="Nouvelle tâche de ma chambre" maxLength={120} />
              <button className="round-btn" style={{ background: 'var(--accent)', color: 'var(--on-accent)', borderColor: 'transparent', flexShrink: 0 }} aria-label="Ajouter"><Icon name="plus" size={18} /></button>
            </div>
            <div className="hscroll">
              {([['none', 'Sans date'], ['today', 'Aujourd’hui'], ['tomorrow', 'Demain'], ['weekend', 'Ce week-end']] as const).map(([v, l]) => (
                <button key={v} type="button" className="pill sm" aria-pressed={when === v} onClick={() => setWhen(v)}>{l}</button>
              ))}
            </div>
          </form>
          {block(`En retard · ${late.length}`, late)}
          {block('Aujourd’hui', now)}
          {block('À venir', soon)}
          {block('Sans date', undated)}
          {todo.length === 0 && <Beige><div className="empty-line">Rien à faire dans ta chambre 🎉</div></Beige>}
          <button className="btn btn-primary btn-big" onClick={() => setOpen('new')}><Icon name="plus" />Nouvelle tâche (date, répétition…)</button>
        </div>
        <div className="mcol">
          <SectionTitle title="Faites récemment" />
          <Beige>
            {done.length === 0 && <div className="empty-line">Rien pour l’instant.</div>}
            {done.map((x) => <PrivateRow key={x.id} t={x} onOpen={setOpen} />)}
          </Beige>
        </div>
      </div>
      {open !== null && <PrivateTaskModal task={open === 'new' ? null : open} onClose={() => setOpen(null)} />}
    </>
  );
}
