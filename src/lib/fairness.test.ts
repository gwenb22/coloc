import { describe, expect, it } from 'vitest';
import type { Occurrence, TaskTemplate } from '../types';
import { fairnessStats, planAssignments, weightOf } from './fairness';

const A = 'a', B = 'b';
const tpl = (id: string, p: Partial<TaskTemplate>): TaskTemplate => ({
  id, household_id: 'h', zone_id: null, name: id, description: '', instructions: '', frequency: 'weekly', weekdays: [1], month_week: null,
  once_date: null, window_days: 0, duration_min: 10, effort: 'light', preferred_user: null, fixed_user: null,
  start_date: '2026-01-01', end_date: null, active: true, archived: false, created_by: null, created_at: '', version: 1, ...p,
});
const occ = (p: Partial<Occurrence>): Occurrence => ({
  id: Math.random().toString(), household_id: 'h', template_id: 't', scheduled_date: '2026-10-01', due_date: '2026-10-01',
  assigned_to: A, status: 'done', proposed: false, locked: false, name: '', zone_id: null, estimated_min: 10, effort: 'light',
  weight: 10, done_at: null, done_by: null, actual_min: null, problem: null, created_at: '', version: 1, ...p,
});
const base = { members: [A, B], unavailabilities: [], settings: {}, start: '2026-10-19', end: '2026-10-25' };

describe('weightOf', () => {
  it('20 min effort important = 30', () => expect(weightOf(20, 'heavy')).toBe(30));
});

describe('planAssignments', () => {
  it('équilibre la charge pondérée, pas le nombre de tâches', () => {
    const templates = [
      tpl('douche', { duration_min: 40, effort: 'heavy' }), // 60
      tpl('a', { duration_min: 10 }), tpl('b', { duration_min: 10 }), tpl('c', { duration_min: 10 }),
      tpl('d', { duration_min: 10 }), tpl('e', { duration_min: 10 }), tpl('f', { duration_min: 10 }),
    ];
    const r = planAssignments({ ...base, templates, occurrences: [] });
    expect(r.totals[A]).toBe(60);
    expect(r.totals[B]).toBe(60);
  });
  it('tient compte de la charge récente (fenêtre de 4 semaines)', () => {
    const r = planAssignments({
      ...base, templates: [tpl('x', { duration_min: 10 })],
      occurrences: [occ({ due_date: '2026-10-10', assigned_to: A, weight: 50 })],
    });
    expect(r.slots[0].assigned_to).toBe(B);
  });
  it('ignore les tâches annulées ou non réalisées dans la charge passée', () => {
    const r = planAssignments({
      ...base, templates: [tpl('x', { duration_min: 10 })],
      occurrences: [occ({ due_date: '2026-10-10', assigned_to: A, weight: 50, status: 'cancelled' }), occ({ due_date: '2026-10-11', assigned_to: B, weight: 5 })],
    });
    expect(r.slots[0].assigned_to).toBe(A);
  });
  it('respecte attributions fixes, verrouillées et indisponibilités', () => {
    const r = planAssignments({
      ...base,
      templates: [tpl('fixe', { fixed_user: B, duration_min: 100 }), tpl('lock', { weekdays: [2] }), tpl('dispo', { weekdays: [3], duration_min: 1 })],
      occurrences: [occ({ template_id: 'lock', scheduled_date: '2026-10-20', due_date: '2026-10-20', assigned_to: B, locked: true, status: 'todo', proposed: true })],
      unavailabilities: [{ id: 'u', household_id: 'h', user_id: A, start_date: '2026-10-21', end_date: '2026-10-21', note: '' }],
    });
    const by = Object.fromEntries(r.slots.map((s) => [s.template_id, s]));
    expect(by.fixe.assigned_to).toBe(B);
    expect(by.lock.assigned_to).toBe(B);
    expect(by.lock.kept).toBe(true);
    expect(by.dispo.assigned_to).toBe(B);
  });
  it('alterne une tâche quotidienne', () => {
    const r = planAssignments({ ...base, templates: [tpl('vaisselle', { frequency: 'daily' })], occurrences: [] });
    const counts = r.slots.reduce<Record<string, number>>((acc, s) => ((acc[s.assigned_to!] = (acc[s.assigned_to!] ?? 0) + 1), acc), {});
    expect(Math.abs(counts[A] - counts[B])).toBeLessThanOrEqual(1);
  });
  it('conserve les attributions déjà validées sauf recalcul explicite', () => {
    const existing = occ({ template_id: 'x', scheduled_date: '2026-10-19', due_date: '2026-10-19', assigned_to: A, status: 'todo', weight: 10 });
    const past = occ({ due_date: '2026-10-10', assigned_to: A, weight: 100 });
    const templates = [tpl('x', {})];
    expect(planAssignments({ ...base, templates, occurrences: [existing, past] }).slots[0].assigned_to).toBe(A);
    expect(planAssignments({ ...base, templates, occurrences: [existing, past], recomputeValidated: true }).slots[0].assigned_to).toBe(B);
  });
});

describe('fairnessStats', () => {
  it('calcule écart et compte les terminées', () => {
    const s = fairnessStats([occ({ weight: 30, estimated_min: 20 }), occ({ assigned_to: B, weight: 10, status: 'todo' }), occ({ assigned_to: B, weight: 99, status: 'cancelled' })], [A, B], '2026-10-01', '2026-10-01');
    expect(s.per[A].weighted).toBe(30);
    expect(s.per[B].weighted).toBe(10);
    expect(s.gap).toBe(20);
    expect(s.per[A].done).toBe(1);
  });
});
