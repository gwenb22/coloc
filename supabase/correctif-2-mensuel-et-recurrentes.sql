-- =====================================================================
-- Correctif n°2 — tâches mensuelles et dépenses récurrentes
-- À exécuter une fois dans Supabase > SQL Editor > New query > Run.
-- (Inutile si vous installez une nouvelle base avec schema.sql à jour.)
-- =====================================================================

-- 1. Tâches mensuelles (« le 2e samedi du mois »)
alter table public.task_templates drop constraint if exists task_templates_frequency_check;
alter table public.task_templates add constraint task_templates_frequency_check
  check (frequency in ('daily', 'weekly', 'monthly', 'once'));
alter table public.task_templates add column if not exists month_week int
  check (month_week is null or month_week in (-1, 1, 2, 3, 4));

-- Le nettoyage du frigo passe d'hebdomadaire à mensuel (4e samedi) ; ses occurrences futures non faites sont annulées
update public.task_occurrences o set status = 'cancelled'
from public.task_templates t
where o.template_id = t.id and t.name = 'Nettoyer le réfrigérateur' and t.frequency = 'weekly'
  and o.status in ('todo', 'in_progress', 'postponed') and o.due_date >= current_date;
update public.task_templates set name = 'Nettoyer le frigo', frequency = 'monthly', weekdays = '{6}', month_week = 4
where name = 'Nettoyer le réfrigérateur' and frequency = 'weekly';

-- Nouvelles tâches mensuelles pour chaque colocation (si elles n'existent pas déjà)
insert into public.task_templates (household_id, zone_id, name, frequency, weekdays, month_week, duration_min, effort, created_by)
select h.id, z.id, t.name, 'monthly', '{6}'::int[], t.mw, t.dur, t.eff, h.created_by
from public.households h
join (values
  ('Salon', 'Laver les vitres', 1, 45, 'heavy'),
  ('Cuisine', 'Nettoyer le four', 2, 30, 'heavy'),
  ('Cuisine', 'Nettoyer le micro-ondes', 3, 10, 'moderate'),
  ('Cuisine', 'Nettoyer le frigo', 4, 25, 'heavy')
) as t(zone, name, mw, dur, eff) on true
join public.zones z on z.household_id = h.id and z.name = t.zone
where not exists (select 1 from public.task_templates x where x.household_id = h.id and x.name = t.name and not x.archived);

-- 2. Dépenses récurrentes
create table public.recurring_expenses (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  title text not null check (length(title) between 1 and 120),
  amount_cents bigint not null check (amount_cents > 0),
  category_id uuid references public.categories(id),
  paid_by uuid not null references public.profiles(id),
  split_mode text not null check (split_mode in ('equal', 'percent', 'fixed', 'single')),
  split_inputs jsonb not null default '[]'::jsonb, -- saisie de partage, recalculée chaque mois
  day_of_month int not null check (day_of_month between 1 and 31),
  start_date date not null default current_date,
  end_date date,
  last_generated date,
  auto_validate boolean not null default true,
  active boolean not null default true,
  note text not null default '',
  created_by uuid references public.profiles(id) default auth.uid(),
  created_at timestamptz not null default now(),
  version int not null default 1,
  check (end_date is null or end_date >= start_date)
);

alter table public.expenses add column if not exists recurring_id uuid references public.recurring_expenses(id) on delete set null;

create trigger chk_recur_members before insert or update on public.recurring_expenses
  for each row execute function public.check_member_columns('paid_by');
create trigger bump_recurring_expenses before update on public.recurring_expenses
  for each row execute function public.bump_version();

alter table public.recurring_expenses enable row level security;
create policy recurring_expenses_select on public.recurring_expenses for select using (public.is_member(household_id));
create policy recurring_expenses_insert on public.recurring_expenses for insert with check (public.is_member(household_id));
create policy recurring_expenses_update on public.recurring_expenses for update using (public.is_member(household_id)) with check (public.is_member(household_id));
create policy recurring_expenses_delete on public.recurring_expenses for delete using (public.is_member(household_id));
grant select, insert, update, delete on public.recurring_expenses to authenticated;
revoke all on public.recurring_expenses from anon;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.recurring_expenses;
  end if;
end $$;

-- 3. save_expense accepte le lien vers la dépense récurrente
drop function if exists public.save_expense(uuid, uuid, int, text, bigint, date, uuid, uuid, text, text, text, uuid, jsonb);
-- Enregistre une dépense et ses parts dans une même transaction, avec contrôle des parts.
-- p_shares : [{ "user_id": "...", "share_cents": 1234, "percent": 50 }]
create or replace function public.save_expense(
  p_id uuid, p_client_key uuid, p_version int, p_title text, p_amount_cents bigint, p_date date,
  p_category_id uuid, p_paid_by uuid, p_split_mode text, p_status text, p_note text,
  p_maintenance_id uuid, p_shares jsonb, p_recurring_id uuid default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  hid uuid := public.my_household();
  eid uuid;
  s jsonb;
  total bigint := 0;
  pct numeric := 0;
  n int := 0;
begin
  if hid is null then raise exception 'Aucune colocation.' using errcode = 'P0001'; end if;
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'Le montant doit être positif.' using errcode = 'P0001';
  end if;
  for s in select * from jsonb_array_elements(p_shares) loop
    if (s->>'share_cents')::bigint < 0 then raise exception 'Part négative.' using errcode = 'P0001'; end if;
    total := total + (s->>'share_cents')::bigint;
    pct := pct + coalesce((s->>'percent')::numeric, 0);
    n := n + 1;
  end loop;
  if n = 0 then raise exception 'Au moins une personne doit être concernée.' using errcode = 'P0001'; end if;
  if total <> p_amount_cents then
    raise exception 'La somme des parts (% c) doit être égale au montant (% c).', total, p_amount_cents using errcode = 'P0001';
  end if;
  if p_split_mode = 'percent' and abs(pct - 100) > 0.001 then
    raise exception 'Les pourcentages doivent totaliser 100 %%.' using errcode = 'P0001';
  end if;

  if p_id is null then
    -- anti-doublon : renvoyer la dépense existante si la même clé client a déjà été utilisée
    select id into eid from public.expenses where client_key = p_client_key and household_id = hid;
    if eid is not null then return eid; end if;
    insert into public.expenses (household_id, client_key, title, amount_cents, date, category_id, paid_by,
      split_mode, status, note, maintenance_id, recurring_id)
    values (hid, p_client_key, p_title, p_amount_cents, p_date, p_category_id, p_paid_by,
      p_split_mode, coalesce(p_status, 'validated'), coalesce(p_note, ''), p_maintenance_id, p_recurring_id)
    returning id into eid;
  else
    update public.expenses set title = p_title, amount_cents = p_amount_cents, date = p_date,
      category_id = p_category_id, paid_by = p_paid_by, split_mode = p_split_mode,
      status = coalesce(p_status, status), note = coalesce(p_note, ''), maintenance_id = p_maintenance_id
    where id = p_id and household_id = hid and version = p_version
    returning id into eid;
    if eid is null then
      raise exception 'Cette dépense a été modifiée entre-temps. Rechargez puis réessayez.' using errcode = 'P0002';
    end if;
    delete from public.expense_shares where expense_id = eid;
  end if;

  insert into public.expense_shares (expense_id, household_id, user_id, share_cents, percent)
  select eid, hid, (x->>'user_id')::uuid, (x->>'share_cents')::bigint, (x->>'percent')::numeric
  from jsonb_array_elements(p_shares) x;
  return eid;
end $$;
