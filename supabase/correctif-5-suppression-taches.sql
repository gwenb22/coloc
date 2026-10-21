-- =====================================================================
-- Correctif n°5 — suppression des tâches
-- À exécuter une fois dans Supabase > SQL Editor > New query > Run.
-- Une tâche jamais réalisée est supprimée définitivement ; une tâche déjà réalisée
-- disparaît du catalogue mais ses réalisations restent dans l'historique et l'équilibre.
-- =====================================================================
alter table public.task_templates add column if not exists deleted_at timestamptz;

create or replace function public.delete_task_template(p_id uuid) returns text
language plpgsql security definer set search_path = public as $$
declare
  t record;
  done_count int;
begin
  select * into t from public.task_templates where id = p_id for update;
  if t.id is null or not public.is_member(t.household_id) then
    raise exception 'Tâche introuvable.' using errcode = 'P0001';
  end if;
  select count(*) into done_count from public.task_occurrences where template_id = p_id and status = 'done';

  -- Les occurrences non réalisées (à faire, en cours, reportées, proposées) ne sont pas de l'historique
  delete from public.swap_requests where occurrence_id in (
    select id from public.task_occurrences where template_id = p_id and status in ('todo', 'in_progress', 'postponed'));
  delete from public.task_occurrences where template_id = p_id and status in ('todo', 'in_progress', 'postponed');

  if done_count = 0 then
    delete from public.swap_requests where occurrence_id in (select id from public.task_occurrences where template_id = p_id);
    delete from public.task_occurrences where template_id = p_id;
    delete from public.comments where entity = 'occurrence' and entity_id not in (select id from public.task_occurrences);
    delete from public.task_templates where id = p_id;
    perform public.log_action(t.household_id, 'template', p_id, 'delete', jsonb_build_object('name', t.name));
    return 'deleted';
  end if;

  update public.task_templates set deleted_at = now(), archived = true, active = false where id = p_id;
  perform public.log_action(t.household_id, 'template', p_id, 'hide', jsonb_build_object('name', t.name, 'done', done_count));
  return 'hidden';
end $$;

revoke execute on function public.delete_task_template(uuid) from public, anon;
grant execute on function public.delete_task_template(uuid) to authenticated;
