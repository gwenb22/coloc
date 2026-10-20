-- =====================================================================
-- OPTIONNEL — rappels quotidiens automatiques (tâches du jour, retards,
-- échéances d'entretien, remboursements prévus).
-- Nécessite l'extension pg_cron : Supabase > Database > Extensions > pg_cron.
-- À exécuter après schema.sql.
-- =====================================================================
create extension if not exists pg_cron;

create or replace function public.daily_reminders() returns void
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  -- Tâches du jour, regroupées par personne
  for r in
    select household_id, assigned_to, count(*) n, string_agg(name, ', ' order by name) names
    from public.task_occurrences
    where due_date = current_date and status in ('todo', 'in_progress', 'postponed') and not proposed and assigned_to is not null
    group by household_id, assigned_to
  loop
    perform public.notify(r.household_id, r.assigned_to, 'task_due',
      r.n || ' tâche(s) aujourd''hui', left(r.names, 200), '/taches');
  end loop;
  -- Tâches en retard
  for r in
    select household_id, assigned_to, count(*) n
    from public.task_occurrences
    where due_date < current_date and status in ('todo', 'in_progress', 'postponed') and not proposed and assigned_to is not null
    group by household_id, assigned_to
  loop
    perform public.notify(r.household_id, r.assigned_to, 'task_overdue',
      r.n || ' tâche(s) en retard', 'À terminer, reporter ou annuler', '/taches');
  end loop;
  -- Entretien : échéance dans les 2 jours
  for r in
    select m.household_id, coalesce(m.owner, hm.user_id) uid, m.title, m.due_date
    from public.maintenance m
    join public.household_members hm on hm.household_id = m.household_id and (m.owner is null or hm.user_id = m.owner)
    where m.status in ('todo', 'in_progress') and m.due_date between current_date and current_date + 2
  loop
    perform public.notify(r.household_id, r.uid, 'maintenance',
      'Échéance proche : ' || r.title, 'Le ' || to_char(r.due_date, 'DD/MM'), '/entretien');
  end loop;
  -- Remboursements prévus arrivés à échéance
  for r in
    select household_id, from_user, amount_cents from public.reimbursements
    where status = 'planned' and date <= current_date
  loop
    perform public.notify(r.household_id, r.from_user, 'reimbursement',
      'Remboursement à effectuer', to_char(r.amount_cents / 100.0, 'FM999999990.00'), '/budget');
  end loop;
end $$;

revoke execute on function public.daily_reminders() from public, anon, authenticated;

-- Tous les jours à 7 h (heure UTC ; 7 h UTC = 8 h ou 9 h en France)
select cron.schedule('coloc-rappels-quotidiens', '0 7 * * *', $$select public.daily_reminders()$$);
