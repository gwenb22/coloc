import type { ISODate, TaskTemplate } from '../types';
import { addDays, weekday } from './dates';

/** Le modèle s'applique-t-il à cette date ? (sans tenir compte des occurrences existantes) */
export function templateAppliesOn(t: Pick<TaskTemplate, 'frequency' | 'weekdays' | 'once_date' | 'start_date' | 'end_date' | 'active' | 'archived'>, date: ISODate): boolean {
  if (!t.active || t.archived) return false;
  if (t.frequency === 'once') return t.once_date === date;
  if (date < t.start_date) return false;
  if (t.end_date && date > t.end_date) return false;
  if (t.frequency === 'daily') return true;
  const days = t.weekdays.length ? t.weekdays : [weekday(t.start_date)];
  return days.includes(weekday(date));
}

/** Dates d'application d'un modèle dans [start, end]. */
export function templateDates(t: TaskTemplate, start: ISODate, end: ISODate): ISODate[] {
  if (t.frequency === 'once') {
    return t.once_date && t.once_date >= start && t.once_date <= end && t.active && !t.archived ? [t.once_date] : [];
  }
  const out: ISODate[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) if (templateAppliesOn(t, d)) out.push(d);
  return out;
}

export function describeFrequency(t: Pick<TaskTemplate, 'frequency' | 'weekdays' | 'once_date'>): string {
  const names = ['lun', 'mar', 'mer', 'jeu', 'ven', 'sam', 'dim'];
  if (t.frequency === 'daily') return 'Tous les jours';
  if (t.frequency === 'once') return t.once_date ? `Le ${t.once_date.split('-').reverse().join('/')}` : 'Ponctuelle';
  if (!t.weekdays.length) return 'Hebdomadaire';
  if (t.weekdays.length === 7) return 'Tous les jours';
  return 'Chaque ' + [...t.weekdays].sort().map((d) => names[d - 1]).join(', ');
}
