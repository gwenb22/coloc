import type { Effort, HouseholdSettings, ISODate, Occurrence, TaskTemplate, Unavailability, UUID } from '../types';
import { addDays, startOfWeek } from './dates';
import { templateDates } from './recurrence';

export const DEFAULT_COEF: Record<Effort, number> = { light: 1.0, moderate: 1.2, heavy: 1.5 };
export const EFFORT_LABEL: Record<Effort, string> = { light: 'Léger', moderate: 'Modéré', heavy: 'Important' };

export function coefs(settings: HouseholdSettings | undefined): Record<Effort, number> {
  return { ...DEFAULT_COEF, ...(settings?.effort_coef ?? {}) };
}

/** Charge pondérée = durée estimée × coefficient d'effort */
export function weightOf(durationMin: number, effort: Effort, c: Record<Effort, number> = DEFAULT_COEF): number {
  return Math.round(durationMin * c[effort] * 100) / 100;
}

export const OPEN_STATUSES = ['todo', 'in_progress', 'postponed'] as const;
export const isOpen = (o: Pick<Occurrence, 'status'>) => (OPEN_STATUSES as readonly string[]).includes(o.status);

export function isUnavailable(unav: Unavailability[], user: UUID, date: ISODate): boolean {
  return unav.some((u) => u.user_id === user && u.start_date <= date && u.end_date >= date);
}

export interface PlanInput {
  members: UUID[];
  templates: TaskTemplate[];
  occurrences: Occurrence[];
  unavailabilities: Unavailability[];
  settings: HouseholdSettings;
  start: ISODate;
  end: ISODate;
  /** true : recalcule aussi les attributions déjà validées (sauf verrouillées / terminées) */
  recomputeValidated?: boolean;
}

export interface PlannedSlot {
  template_id: UUID;
  scheduled_date: ISODate;
  assigned_to: UUID | null;
  weight: number;
  /** occurrence existante à mettre à jour ; absente = à créer */
  existing?: Occurrence;
  /** attribution conservée telle quelle (verrouillée, validée, terminée…) */
  kept: boolean;
  reason: string;
}

export interface PlanResult {
  slots: PlannedSlot[];
  /** charge pondérée de référence (fenêtre glissante passée) */
  baseline: Record<UUID, number>;
  /** charge pondérée totale après planification (référence + période) */
  totals: Record<UUID, number>;
}

/**
 * Proposition de répartition équitable.
 * 1. Identifie les tâches à planifier sur la période (modèles actifs, hors période exclus).
 * 2. Conserve les attributions fixes, verrouillées, validées et les occurrences closes.
 * 3. Part de la charge réalisée sur la fenêtre glissante (4 semaines par défaut) : seules les tâches terminées comptent.
 * 4. Attribue chaque tâche restante (de la plus lourde à la plus légère) à la personne disponible
 *    dont la charge serait la plus faible, avec une pénalité pour les répétitions et un bonus de préférence.
 */
export function planAssignments(input: PlanInput): PlanResult {
  const { members, templates, occurrences, unavailabilities, settings, start, end } = input;
  const c = coefs(settings);
  const windowWeeks = settings.window_weeks ?? 4;
  const avoidRepeats = settings.avoid_repeats !== false;
  const windowStart = addDays(start, -7 * windowWeeks);

  const load: Record<UUID, number> = Object.fromEntries(members.map((m) => [m, 0]));
  const lastBy = new Map<UUID, { date: ISODate; user: UUID }[]>(); // historique par modèle

  const remember = (tplId: UUID, date: ISODate, user: UUID | null) => {
    if (!user) return;
    const arr = lastBy.get(tplId) ?? [];
    arr.push({ date, user });
    lastBy.set(tplId, arr);
  };

  // Charge de référence : tâches terminées dans la fenêtre glissante
  for (const o of occurrences) {
    if (o.due_date >= windowStart && o.due_date < start && o.status === 'done') {
      const who = o.done_by ?? o.assigned_to;
      if (who && who in load) load[who] += Number(o.weight);
    }
    if (o.due_date < start && o.status !== 'cancelled') remember(o.template_id, o.due_date, o.done_by ?? o.assigned_to);
  }
  const baseline = { ...load };

  const existing = new Map(occurrences.map((o) => [`${o.template_id}|${o.scheduled_date}`, o]));
  const slots: PlannedSlot[] = [];
  const todo: { slot: PlannedSlot; tpl: TaskTemplate }[] = [];

  for (const tpl of templates) {
    for (const date of templateDates(tpl, start, end)) {
      const ex = existing.get(`${tpl.id}|${date}`);
      const weight = ex ? Number(ex.weight) : weightOf(tpl.duration_min, tpl.effort, c);
      const slot: PlannedSlot = { template_id: tpl.id, scheduled_date: date, assigned_to: ex?.assigned_to ?? null, weight, existing: ex, kept: false, reason: '' };
      const keep = !!ex && (ex.locked || ex.status === 'done' || (!ex.proposed && !input.recomputeValidated));
      const keptUser = ex ? (ex.status === 'done' ? ex.done_by ?? ex.assigned_to : ex.assigned_to) : null;
      if (ex && ex.status === 'cancelled') {
        slot.kept = true;
        slot.reason = 'Annulée';
        slots.push(slot);
        continue;
      }
      if (keep && ex && keptUser && members.includes(keptUser)) {
        slot.kept = true;
        slot.reason = ex.locked ? 'Attribution verrouillée' : ex.status === 'done' ? 'Déjà terminée' : 'Déjà validée';
        load[keptUser] += weight;
        remember(tpl.id, date, keptUser);
        slots.push(slot);
        continue;
      }
      todo.push({ slot, tpl });
      slots.push(slot);
    }
  }

  // Les tâches à attribution fixe d'abord, puis de la plus lourde à la plus légère
  todo.sort((a, b) => Number(!!b.tpl.fixed_user) - Number(!!a.tpl.fixed_user) || b.slot.weight - a.slot.weight || a.slot.scheduled_date.localeCompare(b.slot.scheduled_date));

  for (const { slot, tpl } of todo) {
    const date = slot.scheduled_date;
    let candidates = members.filter((m) => !isUnavailable(unavailabilities, m, date));
    let reason = '';
    if (candidates.length === 0) {
      candidates = [...members];
      reason = 'Personne n’est disponible : ';
    }
    if (tpl.fixed_user && candidates.includes(tpl.fixed_user)) {
      slot.assigned_to = tpl.fixed_user;
      slot.reason = 'Attribution fixe';
    } else {
      const history = (lastBy.get(tpl.id) ?? []).filter((h) => h.date < date).sort((a, b) => b.date.localeCompare(a.date));
      let best: UUID | null = null;
      let bestScore = Infinity;
      let bestWhy = '';
      for (const m of candidates) {
        let score = load[m] + slot.weight;
        let why = 'charge la plus faible';
        if (avoidRepeats) {
          let streak = 0;
          for (const h of history) {
            if (h.user === m) streak++;
            else break;
          }
          if (streak > 0) score += 0.25 * slot.weight * Math.min(streak, 3);
        }
        if (tpl.preferred_user === m) {
          score -= 0.25 * slot.weight;
          why = 'préférence et charge';
        }
        if (score < bestScore - 1e-9 || (Math.abs(score - bestScore) < 1e-9 && best !== null && load[m] < load[best])) {
          best = m;
          bestScore = score;
          bestWhy = why;
        }
      }
      slot.assigned_to = best;
      slot.reason = reason + (candidates.length < members.length ? 'seule personne disponible' : bestWhy);
    }
    if (slot.assigned_to) {
      load[slot.assigned_to] += slot.weight;
      remember(tpl.id, date, slot.assigned_to);
    }
  }

  slots.sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date));
  return { slots, baseline, totals: load };
}

export interface PersonStats {
  estimated_min: number;
  weighted: number;
  actual_min: number;
  done: number;
  count: number;
}

/** Indicateurs d'équité sur une période. `basis` = 'planned' (tâches attribuées non annulées) ou 'done'. */
export function fairnessStats(occurrences: Occurrence[], members: UUID[], start: ISODate, end: ISODate, basis: 'planned' | 'done' = 'planned') {
  const per: Record<UUID, PersonStats> = Object.fromEntries(members.map((m) => [m, { estimated_min: 0, weighted: 0, actual_min: 0, done: 0, count: 0 }]));
  for (const o of occurrences) {
    if (o.due_date < start || o.due_date > end || o.status === 'cancelled' || o.proposed) continue;
    if (basis === 'done' && o.status !== 'done') continue;
    const who = o.status === 'done' ? o.done_by ?? o.assigned_to : o.assigned_to;
    if (!who || !per[who]) continue;
    const p = per[who];
    p.count++;
    p.estimated_min += o.estimated_min;
    p.weighted += Number(o.weight);
    if (o.status === 'done') {
      p.done++;
      p.actual_min += o.actual_min ?? 0;
    }
  }
  const vals = members.map((m) => per[m].weighted);
  const total = vals.reduce((a, b) => a + b, 0);
  const gap = members.length === 2 ? Math.abs(vals[0] - vals[1]) : 0;
  return { per, total, gap, gapPct: total > 0 ? (gap / total) * 100 : 0 };
}

/** Écart de charge semaine par semaine (charge pondérée attribuée, hors annulées). */
export function weeklyEvolution(occurrences: Occurrence[], members: UUID[], refDate: ISODate, weeks = 4) {
  const out: { week: ISODate; per: Record<UUID, number> }[] = [];
  const first = addDays(startOfWeek(refDate), -7 * (weeks - 1));
  for (let i = 0; i < weeks; i++) {
    const ws = addDays(first, 7 * i);
    const st = fairnessStats(occurrences, members, ws, addDays(ws, 6));
    out.push({ week: ws, per: Object.fromEntries(members.map((m) => [m, st.per[m].weighted])) });
  }
  return out;
}

/** Champs d'une nouvelle occurrence (valeurs figées à partir du modèle). */
export function occurrenceFields(tpl: TaskTemplate, date: ISODate, assigned: UUID | null, weight: number, proposed: boolean) {
  return {
    household_id: tpl.household_id,
    template_id: tpl.id,
    scheduled_date: date,
    due_date: date,
    assigned_to: assigned,
    status: 'todo' as const,
    proposed,
    locked: false,
    name: tpl.name,
    zone_id: tpl.zone_id,
    estimated_min: tpl.duration_min,
    effort: tpl.effort,
    weight,
  };
}

/** En retard : non close et date dépassée (en tenant compte de la plage de réalisation du modèle). */
export function makeIsLate(templates: Pick<TaskTemplate, 'id' | 'window_days'>[], ref: ISODate) {
  const win = new Map(templates.map((t) => [t.id, t.window_days ?? 0]));
  return (o: Pick<Occurrence, 'status' | 'due_date' | 'template_id' | 'proposed'>) =>
    !o.proposed && isOpen(o) && addDays(o.due_date, win.get(o.template_id) ?? 0) < ref;
}
