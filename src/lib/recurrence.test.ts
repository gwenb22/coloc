import { describe, expect, it } from 'vitest';
import type { TaskTemplate } from '../types';
import { describeFrequency, templateDates } from './recurrence';
import { dateInMonth, dueDates, nextDate, stableUuid } from './recurring';

const tpl = (p: Partial<TaskTemplate>): TaskTemplate => ({
  id: 't', household_id: 'h', zone_id: null, name: 'x', description: '', instructions: '', frequency: 'monthly', weekdays: [6], month_week: 1, group_name: null,
  once_date: null, window_days: 0, duration_min: 10, effort: 'light', preferred_user: null, fixed_user: null,
  start_date: '2026-01-01', end_date: null, active: true, archived: false, created_by: null, created_at: '', version: 1, ...p,
});

describe('tâches mensuelles', () => {
  it('1er samedi d’octobre 2026 = le 3', () => expect(templateDates(tpl({ month_week: 1 }), '2026-10-01', '2026-10-31')).toEqual(['2026-10-03']));
  it('4e samedi = le 24', () => expect(templateDates(tpl({ month_week: 4 }), '2026-10-01', '2026-10-31')).toEqual(['2026-10-24']));
  it('dernier samedi = le 31', () => expect(templateDates(tpl({ month_week: -1 }), '2026-10-01', '2026-10-31')).toEqual(['2026-10-31']));
  it('une seule fois par mois sur une année', () => expect(templateDates(tpl({ month_week: 2 }), '2026-01-01', '2026-12-31')).toHaveLength(12));
  it('libellé', () => expect(describeFrequency(tpl({ month_week: 2 }))).toBe('Le 2e samedi du mois'));
});

describe('dépenses récurrentes', () => {
  const r = { day_of_month: 31, start_date: '2026-01-15', end_date: null, last_generated: null, active: true };
  it('jour ramené à la fin du mois', () => expect(dateInMonth('2026-02-01', 31)).toBe('2026-02-28'));
  it('rattrape les mois manquants jusqu’à aujourd’hui', () => expect(dueDates(r, '2026-04-10')).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']));
  it('ne regénère pas ce qui est déjà fait', () => expect(dueDates({ ...r, last_generated: '2026-02-28' }, '2026-04-10')).toEqual(['2026-03-31']));
  it('respecte la date de fin et la pause', () => {
    expect(dueDates({ ...r, end_date: '2026-02-15' }, '2026-04-10')).toEqual(['2026-01-31']);
    expect(dueDates({ ...r, active: false }, '2026-04-10')).toEqual([]);
  });
  it('prochaine échéance', () => expect(nextDate({ ...r, day_of_month: 5 }, '2026-04-10')).toBe('2026-05-05'));
  it('identifiant stable et au format UUID', async () => {
    const a = await stableUuid('r1:2026-03-31');
    expect(a).toBe(await stableUuid('r1:2026-03-31'));
    expect(a).not.toBe(await stableUuid('r1:2026-04-30'));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
