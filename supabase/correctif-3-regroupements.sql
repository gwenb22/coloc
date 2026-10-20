-- =====================================================================
-- Correctif n°3 — regroupement des tâches lors de la répartition
-- À exécuter une fois dans Supabase > SQL Editor > New query > Run (après les correctifs 1 et 2).
-- =====================================================================

-- Groupe nommé : tâches faites le même jour par la même personne
alter table public.task_templates add column if not exists group_name text
  check (group_name is null or length(group_name) between 1 and 40);

-- Groupe « Sols » : aspirateur et lavage des sols de toutes les pièces, le samedi
update public.task_templates set group_name = 'Sols', weekdays = '{6}'
where frequency = 'weekly' and not archived
  and name in ('Laver le sol de la cuisine', 'Sol de la salle de bain', 'Aspirer le salon', 'Ranger les chaussures et nettoyer le sol');

-- Nouvelles tâches (si elles n'existent pas déjà) : sols manquants et groupe « Linge » le dimanche
insert into public.task_templates (household_id, zone_id, name, frequency, weekdays, duration_min, effort, group_name, created_by)
select h.id, z.id, t.name, 'weekly', t.days, t.dur, t.eff, t.grp, h.created_by
from public.households h
join (values
  ('WC', 'Laver le sol des WC', '{6}'::int[], 5, 'moderate', 'Sols'),
  ('Salon', 'Laver le sol du salon', '{6}'::int[], 15, 'moderate', 'Sols'),
  ('Salle de bain', 'Laver serviettes et tapis de bain', '{7}'::int[], 15, 'moderate', 'Linge'),
  ('Cuisine', 'Remplacer éponges et torchons', '{7}'::int[], 5, 'light', 'Linge')
) as t(zone, name, days, dur, eff, grp) on true
join public.zones z on z.household_id = h.id and z.name = t.zone
where not exists (select 1 from public.task_templates x where x.household_id = h.id and x.name = t.name and not x.archived);

-- Occurrences à venir des tâches de sols qui ne tombent plus un samedi : annulées (la prochaine répartition les replanifie)
update public.task_occurrences o set status = 'cancelled'
from public.task_templates t
where o.template_id = t.id and t.group_name = 'Sols' and extract(isodow from o.scheduled_date) <> 6
  and o.status in ('todo', 'in_progress', 'postponed') and o.due_date >= current_date;

-- Propositions non encore validées : supprimées pour être regénérées avec les regroupements
delete from public.task_occurrences where proposed and status = 'todo' and due_date >= current_date;
