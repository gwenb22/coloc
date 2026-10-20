import { useEffect, useRef } from 'react';
import { backend } from '../backend';
import { useStore, useToasts } from '../store';
import type { RecurringExpense } from '../types';
import { computeShares } from '../lib/money';
import { dueDates, stableUuid } from '../lib/recurring';
import { today } from '../lib/dates';
import { errorMessage } from '../lib/util';

/**
 * Crée les dépenses récurrentes arrivées à échéance (y compris les mois manqués) à l'ouverture de l'application.
 * Chaque occurrence a un identifiant stable (règle + date) : si les deux colocataires ouvrent l'app
 * en même temps, la base ne crée qu'une seule dépense.
 */
export function useRecurringGenerator() {
  const { data, online, reload } = useStore();
  const { push } = useToasts();
  const running = useRef(false);

  useEffect(() => {
    if (!data || running.current || (!online && backend.mode === 'supabase')) return;
    const t = today();
    const todo = (data.recurring_expenses ?? []).map((r) => ({ r, dates: dueDates(r, t) })).filter((x) => x.dates.length);
    if (!todo.length) return;
    running.current = true;
    (async () => {
      let created = 0;
      for (const { r, dates } of todo) {
        let last: string | null = null;
        for (const d of dates) {
          try {
            const shares = computeShares(r.amount_cents, r.split_mode, r.split_inputs);
            await backend.rpc('save_expense', {
              p_id: null, p_client_key: await stableUuid(`${r.id}:${d}`), p_version: null, p_title: r.title, p_amount_cents: r.amount_cents, p_date: d,
              p_category_id: r.category_id, p_paid_by: r.paid_by, p_split_mode: r.split_mode, p_status: r.auto_validate ? 'validated' : 'draft',
              p_note: r.note, p_maintenance_id: null, p_shares: shares, p_recurring_id: r.id,
            });
            created++;
            last = d;
          } catch (e) {
            push({ text: `Dépense récurrente « ${r.title} » non créée : ${errorMessage(e)}`, kind: 'error' });
            break;
          }
        }
        if (last) await backend.update<RecurringExpense>('recurring_expenses', r.id, { last_generated: last }).catch(() => undefined);
      }
      if (created) {
        push({ text: created === 1 ? '1 dépense récurrente ajoutée' : `${created} dépenses récurrentes ajoutées`, kind: 'info' });
        await reload();
      }
    })().finally(() => {
      running.current = false;
    });
  }, [data?.recurring_expenses, online]); // eslint-disable-line react-hooks/exhaustive-deps
}
