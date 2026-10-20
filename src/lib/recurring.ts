import type { ISODate, RecurringExpense, SplitInput, SplitMode, UUID } from '../types';
import { addDays, addMonths, endOfMonth } from './dates';

/** Date d'échéance d'une dépense récurrente pour un mois donné (jour ramené à la fin du mois si besoin). */
export function dateInMonth(monthStart: ISODate, day: number): ISODate {
  const last = Number(endOfMonth(monthStart).slice(8));
  return monthStart.slice(0, 8) + String(Math.min(day, last)).padStart(2, '0');
}

/** Échéances à générer jusqu'à aujourd'hui inclus, après la dernière déjà générée. */
export function dueDates(r: Pick<RecurringExpense, 'day_of_month' | 'start_date' | 'end_date' | 'last_generated' | 'active'>, today: ISODate, max = 24): ISODate[] {
  if (!r.active) return [];
  const out: ISODate[] = [];
  let m = r.start_date.slice(0, 8) + '01';
  for (let i = 0; i < 240 && m <= today && out.length < max; i++, m = addMonths(m, 1)) {
    const d = dateInMonth(m, r.day_of_month);
    if (d < r.start_date || d > today) continue;
    if (r.end_date && d > r.end_date) continue;
    if (r.last_generated && d <= r.last_generated) continue;
    out.push(d);
  }
  return out;
}

/** Prochaine échéance (pour l'affichage). */
export function nextDate(r: Pick<RecurringExpense, 'day_of_month' | 'start_date' | 'end_date' | 'active'>, today: ISODate): ISODate | null {
  if (!r.active) return null;
  let m = (today > r.start_date ? today : r.start_date).slice(0, 8) + '01';
  for (let i = 0; i < 24; i++, m = addMonths(m, 1)) {
    const d = dateInMonth(m, r.day_of_month);
    if (d < r.start_date || d < today) continue;
    if (r.end_date && d > r.end_date) return null;
    return d;
  }
  return null;
}

/**
 * Identifiant stable pour l'occurrence d'un mois : sert de client_key, ce qui empêche
 * les doublons si les deux colocataires ouvrent l'application en même temps.
 */
export async function stableUuid(seed: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed));
  const h = [...new Uint8Array(buf)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function describeSplit(mode: SplitMode, inputs: SplitInput[], name: (id: UUID) => string): string {
  if (mode === 'equal') return 'parts égales';
  if (mode === 'single') return `pour ${name(inputs[0]?.user_id)}`;
  if (mode === 'percent') return inputs.map((i) => `${name(i.user_id)} ${i.value ?? 0} %`).join(' · ');
  return 'montants fixes';
}

/** Prochaine échéance d'une tâche privée répétée, strictement après « from » (aujourd'hui par défaut). */
export function nextDue(t: { due_date: ISODate | null; repeat: 'none' | 'weekly' | 'monthly' }, from: ISODate): ISODate | null {
  if (!t.due_date || t.repeat === 'none') return null;
  const day = Number(t.due_date.slice(8));
  let d = t.due_date;
  do d = t.repeat === 'weekly' ? addDays(d, 7) : dateInMonth(addMonths(d, 1), day);
  while (d <= from);
  return d;
}
