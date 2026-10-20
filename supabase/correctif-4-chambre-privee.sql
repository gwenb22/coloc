-- =====================================================================
-- Correctif n°4 — « Ma chambre » : tâches privées de chaque colocataire
-- À exécuter une fois dans Supabase > SQL Editor > New query > Run.
-- Visibles uniquement par leur autrice ; jamais comptées dans la répartition.
-- =====================================================================
create table if not exists public.private_tasks (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  user_id uuid not null references public.profiles(id) default auth.uid(),
  title text not null check (length(title) between 1 and 120),
  note text not null default '',
  due_date date,
  repeat text not null default 'none' check (repeat in ('none', 'weekly', 'monthly')),
  done boolean not null default false,
  done_at timestamptz,
  created_at timestamptz not null default now(),
  version int not null default 1
);
create index if not exists private_tasks_owner on public.private_tasks (user_id, due_date);

drop trigger if exists bump_private_tasks on public.private_tasks;
create trigger bump_private_tasks before update on public.private_tasks
  for each row execute function public.bump_version();

alter table public.private_tasks enable row level security;
-- Uniquement la personne concernée, et seulement au sein de sa colocation
drop policy if exists private_tasks_select on public.private_tasks;
drop policy if exists private_tasks_insert on public.private_tasks;
drop policy if exists private_tasks_update on public.private_tasks;
drop policy if exists private_tasks_delete on public.private_tasks;
create policy private_tasks_select on public.private_tasks for select using (user_id = auth.uid());
create policy private_tasks_insert on public.private_tasks for insert with check (user_id = auth.uid() and public.is_member(household_id));
create policy private_tasks_update on public.private_tasks for update using (user_id = auth.uid()) with check (user_id = auth.uid() and public.is_member(household_id));
create policy private_tasks_delete on public.private_tasks for delete using (user_id = auth.uid());
grant select, insert, update, delete on public.private_tasks to authenticated;
revoke all on public.private_tasks from anon;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'private_tasks') then
    alter publication supabase_realtime add table public.private_tasks;
  end if;
end $$;
