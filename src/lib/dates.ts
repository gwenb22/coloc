import type { ISODate } from '../types';

// Toutes les dates « calendrier » sont manipulées en heure locale au format AAAA-MM-JJ.

export function toISO(d: Date): ISODate {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function fromISO(s: ISODate): Date {
  const [y, m, d] = s.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d, 12); // midi : évite les décalages d'heure d'été
}

export function today(): ISODate {
  return toISO(new Date());
}

export function addDays(s: ISODate, n: number): ISODate {
  const d = fromISO(s);
  d.setDate(d.getDate() + n);
  return toISO(d);
}

export function addMonths(s: ISODate, n: number): ISODate {
  const d = fromISO(s);
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  return toISO(d);
}

/** 1 = lundi … 7 = dimanche */
export function weekday(s: ISODate): number {
  const w = fromISO(s).getDay();
  return w === 0 ? 7 : w;
}

export function startOfWeek(s: ISODate): ISODate {
  return addDays(s, 1 - weekday(s));
}

export function startOfMonth(s: ISODate): ISODate {
  return s.slice(0, 8) + '01';
}

export function endOfMonth(s: ISODate): ISODate {
  return addDays(addMonths(startOfMonth(s), 1), -1);
}

export function daysBetween(a: ISODate, b: ISODate): number {
  return Math.round((fromISO(b).getTime() - fromISO(a).getTime()) / 86400000);
}

export function range(start: ISODate, end: ISODate): ISODate[] {
  const out: ISODate[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

export const WEEKDAYS_SHORT = ['lun', 'mar', 'mer', 'jeu', 'ven', 'sam', 'dim'];
export const WEEKDAYS_LONG = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
export const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

export function fmtDate(s: ISODate | null | undefined, opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' }): string {
  if (!s) return '';
  return fromISO(s).toLocaleDateString('fr-FR', opts);
}

export function fmtDateLong(s: ISODate): string {
  return fmtDate(s, { weekday: 'long', day: 'numeric', month: 'long' });
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function relativeDay(s: ISODate, ref: ISODate = today()): string {
  const n = daysBetween(ref, s);
  if (n === 0) return "aujourd'hui";
  if (n === 1) return 'demain';
  if (n === -1) return 'hier';
  if (n < 0) return `il y a ${-n} j`;
  if (n < 7) return WEEKDAYS_LONG[weekday(s) - 1];
  return fmtDate(s);
}

export function monthLabel(year: number, month: number): string {
  return `${MONTHS[month - 1]} ${year}`;
}
