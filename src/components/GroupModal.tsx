import { useMemo, useState } from 'react';
import { backend } from '../backend';
import { useData } from '../store';
import type { Household, TaskTemplate } from '../types';
import { Field, Icon, Modal, useConfirm } from './ui';
import { GroupBadge } from './mobile';
import { GROUP_COLORS, listGroups } from '../lib/groups';
import { describeFrequency } from '../lib/recurrence';
import { WEEKDAYS_LONG } from '../lib/dates';
import { cx } from '../lib/util';

/**
 * Création / modification d'un groupe de tâches : nom, couleur, tâches membres, jour commun.
 * Les tâches d'un groupe tombant le même jour sont attribuées à une seule personne.
 */
export function GroupModal({ group, onClose }: { group: string | null; onClose: () => void }) {
  const { data, run } = useData();
  const confirm = useConfirm();
  const groups = listGroups(data);
  const current = group ? groups.find((g) => g.name === group) : undefined;
  const [name, setName] = useState(current?.name ?? '');
  const [color, setColor] = useState(current?.color ?? GROUP_COLORS[groups.length % GROUP_COLORS.length]);
  const [day, setDay] = useState<number | ''>('');
  const inGroup = (t: TaskTemplate) => !!group && t.group_name?.trim().toLowerCase() === group.toLowerCase();
  const templates = useMemo(() => data.task_templates.filter((t) => !t.archived), [data.task_templates]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(templates.filter(inGroup).map((t) => t.id)));
  const [err, setErr] = useState('');
  const zones = [...data.zones].sort((a, b) => a.position - b.position);

  const toggle = (id: string) => setSelected((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });

  const saveSettings = async (mutate: (g: Record<string, { color: string }>) => void) => {
    const h = data.household;
    const g = { ...(h.settings.groups ?? {}) };
    mutate(g);
    await backend.update<Household>('households', h.id, { settings: { ...h.settings, groups: g } }, h.version);
  };

  const save = async () => {
    setErr('');
    const n = name.trim();
    if (!n) return setErr('Donnez un nom au groupe.');
    if (n.length > 40) return setErr('40 caractères maximum.');
    if (groups.some((g) => g.name.toLowerCase() === n.toLowerCase() && g.name !== group)) return setErr('Un groupe porte déjà ce nom.');
    const r = await run(async () => {
      await saveSettings((g) => {
        if (group && group !== n) delete g[group];
        g[n] = { color };
      });
      for (const t of templates) {
        const want = selected.has(t.id);
        const patch: Partial<TaskTemplate> = {};
        if (want && t.group_name !== n) patch.group_name = n;
        if (!want && inGroup(t)) patch.group_name = null;
        if (want && day !== '' && t.frequency === 'weekly' && (t.weekdays.length !== 1 || t.weekdays[0] !== day)) patch.weekdays = [day];
        if (want && day !== '' && t.frequency === 'monthly' && t.weekdays[0] !== day) patch.weekdays = [day];
        if (Object.keys(patch).length) await backend.update('task_templates', t.id, patch);
      }
      return true;
    }, { success: group ? 'Groupe modifié' : 'Groupe créé', tables: ['households', 'task_templates'], key: 'group' });
    if (r) onClose();
  };

  const remove = async () => {
    if (!group) return;
    if (!(await confirm({ title: `Supprimer le groupe « ${group} » ?`, message: 'Les tâches sont conservées : elles quittent simplement le groupe et seront de nouveau réparties une par une (ou par pièce).', confirm: 'Supprimer le groupe', danger: true }))) return;
    const r = await run(async () => {
      await saveSettings((g) => { delete g[group]; });
      for (const t of templates.filter(inGroup)) await backend.update('task_templates', t.id, { group_name: null });
      return true;
    }, { success: 'Groupe supprimé', tables: ['households', 'task_templates'] });
    if (r) onClose();
  };

  return (
    <Modal title={group ? 'Modifier le groupe' : 'Nouveau groupe'} onClose={onClose} wide footer={
      <>
        {group && <button className="btn btn-danger" style={{ marginRight: 'auto' }} onClick={remove}>Supprimer</button>}
        <button className="btn" onClick={onClose}>Annuler</button>
        <button className="btn btn-primary" onClick={save}>Enregistrer</button>
      </>
    }>
      <p className="small muted">Les tâches d’un groupe qui tombent le même jour sont données à la même personne, même si elles sont dans des pièces différentes.</p>
      <div className="form-grid">
        <Field label="Nom du groupe"><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex. : Sols, Linge, Cuisine à fond" maxLength={40} /></Field>
        <Field label="Aperçu"><div style={{ paddingTop: 10 }}><GroupBadge name={name.trim() || 'Groupe'} color={color} /></div></Field>
        <Field label="Couleur" className="full">
          <div className="swatches">
            {GROUP_COLORS.map((c) => (
              <button key={c} type="button" className={cx('swatch', color.toLowerCase() === c.toLowerCase() && 'on')} style={{ background: c }} onClick={() => setColor(c)} aria-label={`Couleur ${c}`} />
            ))}
            <label className="swatch custom" title="Couleur personnalisée" style={{ background: GROUP_COLORS.some((c) => c.toLowerCase() === color.toLowerCase()) ? undefined : color }}>
              <input type="color" value={color} onChange={(e) => setColor(e.target.value)} aria-label="Couleur personnalisée" />
              <Icon name="plus" size={16} />
            </label>
          </div>
        </Field>
        <Field label="Jour commun (facultatif)" className="full" hint="Place toutes les tâches hebdomadaires et mensuelles cochées ci-dessous sur ce jour.">
          <select className="select" value={day} onChange={(e) => setDay(e.target.value ? Number(e.target.value) : '')}>
            <option value="">Ne pas changer les jours</option>
            {WEEKDAYS_LONG.map((d, i) => <option key={d} value={i + 1}>Toutes le {d}</option>)}
          </select>
        </Field>
      </div>
      <div className="form-section">
        <h4>Tâches du groupe ({selected.size})</h4>
        {zones.map((z) => {
          const list = templates.filter((t) => t.zone_id === z.id);
          if (!list.length) return null;
          return (
            <div key={z.id} className="stack-sm">
              <div className="small strong">{z.icon} {z.name}</div>
              {list.map((t) => {
                const other = t.group_name?.trim() && !inGroup(t) ? t.group_name : null;
                return (
                  <label key={t.id} className="toggle group-task">
                    <input type="checkbox" checked={selected.has(t.id)} onChange={() => toggle(t.id)} />
                    <span className="grow">{t.name} <span className="xs muted">· {describeFrequency(t)}{other && selected.has(t.id) ? ` · quittera « ${other} »` : other ? ` · groupe ${other}` : ''}</span></span>
                  </label>
                );
              })}
            </div>
          );
        })}
      </div>
      {err && <div className="error-box">{err}</div>}
    </Modal>
  );
}
