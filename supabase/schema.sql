-- =====================================================================
-- Coloc — schéma Supabase (PostgreSQL)
-- À exécuter une seule fois dans Supabase > SQL Editor > New query.
-- Toutes les tables privées sont protégées par Row Level Security :
-- seules les personnes membres d'une colocation voient ses données.
-- =====================================================================


-- ---------------------------------------------------------------------
-- Profils (créés automatiquement à l'inscription)
-- Pas de clé étrangère vers auth.users : le profil survit à la
-- suppression d'un compte pour préserver l'historique commun.
-- ---------------------------------------------------------------------
create table public.profiles (
  id uuid primary key,
  display_name text not null default '',
  notif_prefs jsonb not null default '{}'::jsonb,
  ui_prefs jsonb not null default '{}'::jsonb,
  deleted boolean not null default false,
  created_at timestamptz not null default now(),
  version int not null default 1
);

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------
-- Colocations et membres
-- ---------------------------------------------------------------------
create table public.households (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 80),
  currency text not null default 'EUR',
  start_date date not null default current_date,
  invite_code text unique,
  settings jsonb not null default '{}'::jsonb,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  version int not null default 1
);

create table public.household_members (
  household_id uuid not null references public.households(id) on delete cascade,
  user_id uuid not null references public.profiles(id),
  role text not null default 'member' check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  primary key (household_id, user_id),
  unique (user_id) -- une personne appartient à une seule colocation
);

-- Fonction d'appartenance utilisée par toutes les règles RLS.
create or replace function public.is_member(hid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.household_members
    where household_id = hid and user_id = auth.uid()
  );
$$;

create or replace function public.my_household() returns uuid
language sql stable security definer set search_path = public as $$
  select household_id from public.household_members where user_id = auth.uid();
$$;

-- Deux membres au maximum.
create or replace function public.check_member_limit() returns trigger
language plpgsql as $$
begin
  if (select count(*) from public.household_members where household_id = new.household_id) >= 2 then
    raise exception 'Cette colocation a déjà deux membres.' using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger household_members_limit
  before insert on public.household_members
  for each row execute function public.check_member_limit();

-- Vérifie que les colonnes désignant une personne pointent vers un membre
-- de la même colocation. Arguments : noms des colonnes à contrôler.
create or replace function public.check_member_columns() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  col text;
  uid uuid;
  row_json jsonb := to_jsonb(new);
begin
  foreach col in array tg_argv loop
    uid := nullif(row_json->>col, '')::uuid;
    if uid is not null and not exists (
      select 1 from public.household_members
      where household_id = (row_json->>'household_id')::uuid and user_id = uid
    ) then
      raise exception 'La personne indiquée (%) ne fait pas partie de la colocation.', col using errcode = 'P0001';
    end if;
  end loop;
  return new;
end $$;

-- Incrément de version pour détecter les modifications concurrentes.
create or replace function public.bump_version() returns trigger
language plpgsql as $$
begin
  new.version := old.version + 1;
  return new;
end $$;

-- ---------------------------------------------------------------------
-- Journal des actions importantes (historique)
-- ---------------------------------------------------------------------
create table public.activity_log (
  id bigint generated always as identity primary key,
  household_id uuid not null references public.households(id) on delete cascade,
  user_id uuid,
  entity text not null,
  entity_id uuid,
  action text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index on public.activity_log (household_id, entity, entity_id);

create or replace function public.log_action(hid uuid, ent text, eid uuid, act text, det jsonb)
returns void language sql security definer set search_path = public as $$
  insert into public.activity_log (household_id, user_id, entity, entity_id, action, details)
  values (hid, auth.uid(), ent, eid, act, coalesce(det, '{}'::jsonb));
$$;

-- ---------------------------------------------------------------------
-- Espaces, catégories
-- ---------------------------------------------------------------------
create table public.zones (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  name text not null,
  icon text not null default '🏠',
  active boolean not null default true,
  position int not null default 0,
  version int not null default 1
);

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  kind text not null check (kind in ('expense', 'shopping')),
  name text not null,
  position int not null default 0,
  archived boolean not null default false,
  version int not null default 1
);

-- ---------------------------------------------------------------------
-- Tâches : modèles (récurrences) et occurrences datées
-- ---------------------------------------------------------------------
create table public.task_templates (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  zone_id uuid references public.zones(id),
  name text not null,
  description text not null default '',
  instructions text not null default '',
  frequency text not null check (frequency in ('daily', 'weekly', 'monthly', 'once')),
  weekdays int[] not null default '{}', -- 1 = lundi … 7 = dimanche
  month_week int check (month_week is null or month_week in (-1, 1, 2, 3, 4)), -- mensuelle : n-ième jour du mois
  once_date date,
  window_days int not null default 0 check (window_days between 0 and 6), -- plage de réalisation
  duration_min int not null check (duration_min between 1 and 600),
  effort text not null default 'moderate' check (effort in ('light', 'moderate', 'heavy')),
  preferred_user uuid references public.profiles(id),
  fixed_user uuid references public.profiles(id),
  start_date date not null default current_date,
  end_date date,
  active boolean not null default true,
  archived boolean not null default false,
  created_by uuid references public.profiles(id) default auth.uid(),
  created_at timestamptz not null default now(),
  version int not null default 1,
  check (end_date is null or end_date >= start_date),
  check (frequency <> 'once' or once_date is not null)
);

create table public.task_occurrences (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  template_id uuid not null references public.task_templates(id),
  scheduled_date date not null,   -- date d'origine, immuable : empêche les doublons
  due_date date not null,         -- date actuelle (après report éventuel)
  assigned_to uuid references public.profiles(id),
  status text not null default 'todo'
    check (status in ('todo', 'in_progress', 'done', 'postponed', 'cancelled')),
  proposed boolean not null default false, -- proposition non encore validée
  locked boolean not null default false,   -- attribution manuelle à conserver
  -- Valeurs figées au moment de la planification (l'historique ne change pas)
  name text not null,
  zone_id uuid references public.zones(id),
  estimated_min int not null,
  effort text not null,
  weight numeric(8,2) not null,
  done_at timestamptz,
  done_by uuid references public.profiles(id),
  actual_min int check (actual_min is null or actual_min between 0 and 1440),
  problem text,
  created_at timestamptz not null default now(),
  version int not null default 1,
  unique (template_id, scheduled_date)
);
create index on public.task_occurrences (household_id, due_date);

create table public.unavailabilities (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  user_id uuid not null references public.profiles(id),
  start_date date not null,
  end_date date not null,
  note text not null default '',
  check (end_date >= start_date)
);

create table public.swap_requests (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  occurrence_id uuid not null references public.task_occurrences(id),
  from_user uuid not null references public.profiles(id),
  to_user uuid not null references public.profiles(id),
  message text not null default '',
  status text not null default 'pending' check (status in ('pending', 'accepted', 'refused', 'cancelled')),
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  version int not null default 1
);
-- Une seule demande en attente par occurrence
create unique index swap_one_pending on public.swap_requests (occurrence_id) where status = 'pending';

create table public.comments (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  entity text not null check (entity in ('occurrence', 'maintenance', 'expense')),
  entity_id uuid not null,
  user_id uuid not null references public.profiles(id) default auth.uid(),
  body text not null check (length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index on public.comments (entity, entity_id);

-- ---------------------------------------------------------------------
-- Budget
-- ---------------------------------------------------------------------
create table public.maintenance (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  title text not null,
  description text not null default '',
  category text not null default 'Autre',
  reported_at date not null default current_date,
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  owner uuid references public.profiles(id),
  due_date date,
  status text not null default 'todo' check (status in ('todo', 'in_progress', 'resolved', 'abandoned')),
  created_by uuid references public.profiles(id) default auth.uid(),
  created_at timestamptz not null default now(),
  version int not null default 1
);

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

create table public.expenses (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  client_key uuid not null unique, -- anti-doublon en cas de double envoi
  title text not null check (length(title) between 1 and 120),
  amount_cents bigint not null check (amount_cents > 0),
  date date not null,
  category_id uuid references public.categories(id),
  paid_by uuid not null references public.profiles(id),
  split_mode text not null check (split_mode in ('equal', 'percent', 'fixed', 'single')),
  status text not null default 'validated' check (status in ('draft', 'validated', 'cancelled')),
  note text not null default '',
  maintenance_id uuid references public.maintenance(id),
  recurring_id uuid references public.recurring_expenses(id) on delete set null,
  created_by uuid references public.profiles(id) default auth.uid(),
  created_at timestamptz not null default now(),
  version int not null default 1
);
create index on public.expenses (household_id, date);

create table public.expense_shares (
  expense_id uuid not null references public.expenses(id) on delete cascade,
  household_id uuid not null references public.households(id) on delete cascade,
  user_id uuid not null references public.profiles(id),
  share_cents bigint not null check (share_cents >= 0),
  percent numeric(6,3),
  primary key (expense_id, user_id)
);

create table public.reimbursements (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  client_key uuid not null unique,
  from_user uuid not null references public.profiles(id),
  to_user uuid not null references public.profiles(id),
  amount_cents bigint not null check (amount_cents > 0),
  date date not null,
  note text not null default '',
  status text not null default 'done' check (status in ('planned', 'done', 'cancelled')),
  created_by uuid references public.profiles(id) default auth.uid(),
  created_at timestamptz not null default now(),
  version int not null default 1,
  check (from_user <> to_user)
);

create table public.budgets (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  period text not null check (period in ('month', 'year')),
  year int not null check (year between 2000 and 2100),
  month int not null default 0 check (month between 0 and 12), -- 0 pour un budget annuel
  total_cents bigint not null check (total_cents >= 0),
  category_limits jsonb not null default '{}'::jsonb, -- { "<category_id>": cents }
  version int not null default 1,
  unique (household_id, period, year, month),
  check ((period = 'year' and month = 0) or (period = 'month' and month between 1 and 12))
);

-- ---------------------------------------------------------------------
-- Courses, stocks
-- ---------------------------------------------------------------------
create table public.stocks (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  name text not null,
  quantity numeric(10,2) not null default 0 check (quantity >= 0),
  unit text not null default '',
  min_threshold numeric(10,2) not null default 1 check (min_threshold >= 0),
  location text not null default '',
  updated_at timestamptz not null default now(),
  version int not null default 1
);

create table public.shopping_items (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  name text not null check (length(name) between 1 and 120),
  quantity numeric(10,2) not null default 1 check (quantity > 0),
  unit text not null default '',
  category text not null default 'Autres',
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high')),
  assigned_to uuid references public.profiles(id),
  status text not null default 'to_buy' check (status in ('to_buy', 'bought', 'deleted')),
  note text not null default '',
  price_estimate_cents bigint check (price_estimate_cents is null or price_estimate_cents >= 0),
  stock_id uuid references public.stocks(id),
  bought_at timestamptz,
  bought_by uuid references public.profiles(id),
  created_by uuid references public.profiles(id) default auth.uid(),
  created_at timestamptz not null default now(),
  version int not null default 1
);

-- ---------------------------------------------------------------------
-- Notifications
-- ---------------------------------------------------------------------
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  user_id uuid not null references public.profiles(id),
  type text not null,
  title text not null,
  body text not null default '',
  link text not null default '',
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index on public.notifications (user_id, created_at desc);

-- Crée une notification si la personne destinataire accepte cette catégorie.
create or replace function public.notify(hid uuid, recipient uuid, ntype text, ntitle text, nbody text, nlink text)
returns void language plpgsql security definer set search_path = public as $$
declare prefs jsonb;
begin
  if recipient is null then return; end if;
  select notif_prefs into prefs from public.profiles where id = recipient;
  if coalesce(prefs->>'enabled', 'true') = 'false' then return; end if;
  if coalesce(prefs->'categories'->>ntype, 'true') = 'false' then return; end if;
  insert into public.notifications (household_id, user_id, type, title, body, link)
  values (hid, recipient, ntype, ntitle, coalesce(nbody, ''), coalesce(nlink, ''));
end $$;

create or replace function public.other_member(hid uuid, uid uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select user_id from public.household_members where household_id = hid and user_id <> uid limit 1;
$$;

create or replace function public.display_name(uid uuid) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(nullif(display_name, ''), 'Colocataire') from public.profiles where id = uid;
$$;

-- ---------------------------------------------------------------------
-- Déclencheurs : contrôles d'appartenance
-- ---------------------------------------------------------------------
create trigger chk_tpl_members before insert or update on public.task_templates
  for each row execute function public.check_member_columns('preferred_user', 'fixed_user');
create trigger chk_occ_members before insert or update on public.task_occurrences
  for each row execute function public.check_member_columns('assigned_to', 'done_by');
create trigger chk_unav_members before insert or update on public.unavailabilities
  for each row execute function public.check_member_columns('user_id');
create trigger chk_swap_members before insert or update on public.swap_requests
  for each row execute function public.check_member_columns('from_user', 'to_user');
create trigger chk_exp_members before insert or update on public.expenses
  for each row execute function public.check_member_columns('paid_by');
create trigger chk_share_members before insert or update on public.expense_shares
  for each row execute function public.check_member_columns('user_id');
create trigger chk_recur_members before insert or update on public.recurring_expenses
  for each row execute function public.check_member_columns('paid_by');
create trigger chk_reimb_members before insert or update on public.reimbursements
  for each row execute function public.check_member_columns('from_user', 'to_user');
create trigger chk_shop_members before insert or update on public.shopping_items
  for each row execute function public.check_member_columns('assigned_to', 'bought_by');
create trigger chk_maint_members before insert or update on public.maintenance
  for each row execute function public.check_member_columns('owner');

-- Versions
do $$
declare t text;
begin
  foreach t in array array['profiles','households','zones','categories','task_templates','task_occurrences',
    'swap_requests','maintenance','expenses','recurring_expenses','reimbursements','budgets','stocks','shopping_items'] loop
    execute format('create trigger %I before update on public.%I for each row execute function public.bump_version()',
      'bump_' || t, t);
  end loop;
end $$;

-- Cohérence des parts : la somme des parts doit égaler le montant (vérifié en fin de transaction).
create or replace function public.check_expense_shares() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  eid uuid;
  total bigint;
  shares bigint;
  n int;
begin
  if tg_table_name = 'expenses' then eid := new.id;
  elsif tg_op = 'DELETE' then eid := old.expense_id;
  else eid := new.expense_id; end if;
  select amount_cents into total from public.expenses where id = eid;
  if total is null then return null; end if; -- dépense supprimée
  select coalesce(sum(share_cents), 0), count(*) into shares, n from public.expense_shares where expense_id = eid;
  if n = 0 or shares <> total then
    raise exception 'Les parts (% c) ne correspondent pas au montant (% c).', shares, total using errcode = 'P0001';
  end if;
  return null;
end $$;

create constraint trigger expense_shares_sum
  after insert or update or delete on public.expense_shares
  deferrable initially deferred
  for each row execute function public.check_expense_shares();
create constraint trigger expense_amount_sum
  after insert or update of amount_cents on public.expenses
  deferrable initially deferred
  for each row execute function public.check_expense_shares();

-- Une dépense réglée ne peut pas voir son montant ou son payeur modifié
-- s'il existe des remboursements postérieurs : on l'annule et on en crée une nouvelle.
-- (Règle souple : on journalise toutes les modifications ci-dessous.)
create or replace function public.log_expense_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform public.log_action(new.household_id, 'expense', new.id, 'create',
      jsonb_build_object('title', new.title, 'amount_cents', new.amount_cents));
    if new.status = 'validated' then
      perform public.notify(new.household_id, public.other_member(new.household_id, auth.uid()), 'expense',
        'Nouvelle dépense : ' || new.title,
        public.display_name(auth.uid()) || ' a ajouté ' || to_char(new.amount_cents / 100.0, 'FM999999990.00') || ' ' || (select currency from public.households where id = new.household_id),
        '/budget');
    end if;
  else
    perform public.log_action(new.household_id, 'expense', new.id, 'update',
      jsonb_build_object('before', to_jsonb(old) - 'version', 'after', to_jsonb(new) - 'version'));
    perform public.notify(new.household_id, public.other_member(new.household_id, auth.uid()), 'expense',
      'Dépense modifiée : ' || new.title,
      case when new.status = 'cancelled' and old.status <> 'cancelled' then 'Dépense annulée' else 'Informations mises à jour' end,
      '/budget');
  end if;
  return null;
end $$;
create trigger expenses_log after insert or update on public.expenses
  for each row execute function public.log_expense_change();

create or replace function public.log_reimbursement() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.log_action(new.household_id, 'reimbursement', new.id, lower(tg_op), to_jsonb(new));
  if tg_op = 'INSERT' or old.status is distinct from new.status then
    perform public.notify(new.household_id, public.other_member(new.household_id, auth.uid()), 'reimbursement',
      case new.status when 'done' then 'Remboursement enregistré' when 'planned' then 'Remboursement prévu' else 'Remboursement annulé' end,
      public.display_name(new.from_user) || ' → ' || public.display_name(new.to_user) || ' : ' ||
        to_char(new.amount_cents / 100.0, 'FM999999990.00'),
      '/budget');
  end if;
  return null;
end $$;
create trigger reimbursements_log after insert or update on public.reimbursements
  for each row execute function public.log_reimbursement();

-- Historique des changements d'attribution et notifications de tâches
create or replace function public.log_occurrence() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    if old.assigned_to is distinct from new.assigned_to then
      perform public.log_action(new.household_id, 'occurrence', new.id, 'reassign',
        jsonb_build_object('from', old.assigned_to, 'to', new.assigned_to));
      if not new.proposed and new.assigned_to is distinct from auth.uid() then
        perform public.notify(new.household_id, new.assigned_to, 'task_assigned',
          'Tâche attribuée : ' || new.name, 'Prévue le ' || to_char(new.due_date, 'DD/MM'), '/taches');
      end if;
    end if;
    if old.status is distinct from new.status then
      perform public.log_action(new.household_id, 'occurrence', new.id, 'status',
        jsonb_build_object('from', old.status, 'to', new.status));
    end if;
    if old.due_date is distinct from new.due_date then
      perform public.log_action(new.household_id, 'occurrence', new.id, 'postpone',
        jsonb_build_object('from', old.due_date, 'to', new.due_date));
    end if;
    if old.proposed and not new.proposed and new.assigned_to is distinct from auth.uid() then
      perform public.notify(new.household_id, new.assigned_to, 'task_assigned',
        'Tâche attribuée : ' || new.name, 'Prévue le ' || to_char(new.due_date, 'DD/MM'), '/taches');
    end if;
  end if;
  return null;
end $$;
create trigger occurrences_log after update on public.task_occurrences
  for each row execute function public.log_occurrence();

create or replace function public.notify_swap() returns trigger
language plpgsql security definer set search_path = public as $$
declare occ_name text;
begin
  select name into occ_name from public.task_occurrences where id = new.occurrence_id;
  if tg_op = 'INSERT' then
    perform public.notify(new.household_id, new.to_user, 'swap',
      'Demande d''échange : ' || occ_name, coalesce(nullif(new.message, ''), public.display_name(new.from_user) || ' vous propose de reprendre cette tâche'), '/notifications');
  elsif old.status = 'pending' and new.status in ('accepted', 'refused') then
    perform public.notify(new.household_id, new.from_user, 'swap',
      'Échange ' || case new.status when 'accepted' then 'accepté' else 'refusé' end || ' : ' || occ_name,
      public.display_name(new.to_user), '/taches');
  end if;
  perform public.log_action(new.household_id, 'swap', new.id, lower(tg_op), to_jsonb(new));
  return null;
end $$;
create trigger swaps_notify after insert or update on public.swap_requests
  for each row execute function public.notify_swap();

create or replace function public.notify_shopping() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.notify(new.household_id, public.other_member(new.household_id, auth.uid()), 'shopping',
    'Courses : ' || new.name, public.display_name(auth.uid()) || ' a ajouté un article', '/courses');
  return null;
end $$;
create trigger shopping_notify after insert on public.shopping_items
  for each row execute function public.notify_shopping();

create or replace function public.notify_stock() returns trigger
language plpgsql security definer set search_path = public as $$
declare m uuid;
begin
  new.updated_at := now();
  if new.quantity <= new.min_threshold and (tg_op = 'INSERT' or old.quantity > old.min_threshold) then
    for m in select user_id from public.household_members where household_id = new.household_id loop
      perform public.notify(new.household_id, m, 'stock',
        'Bientôt épuisé : ' || new.name, 'Quantité : ' || new.quantity::text, '/courses');
    end loop;
  end if;
  return new;
end $$;
create trigger stocks_notify before insert or update on public.stocks
  for each row execute function public.notify_stock();

create or replace function public.log_maintenance() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.log_action(new.household_id, 'maintenance', new.id, lower(tg_op),
    case when tg_op = 'UPDATE' then jsonb_build_object('before', to_jsonb(old) - 'version', 'after', to_jsonb(new) - 'version') else to_jsonb(new) end);
  if new.owner is not null and new.owner is distinct from auth.uid()
     and (tg_op = 'INSERT' or old.owner is distinct from new.owner) then
    perform public.notify(new.household_id, new.owner, 'maintenance', 'Entretien à suivre : ' || new.title, '', '/entretien');
  end if;
  return null;
end $$;
create trigger maintenance_log after insert or update on public.maintenance
  for each row execute function public.log_maintenance();

create or replace function public.log_template() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.log_action(new.household_id, 'template', new.id, lower(tg_op),
    case when tg_op = 'UPDATE' then jsonb_build_object('before', to_jsonb(old) - 'version', 'after', to_jsonb(new) - 'version') else to_jsonb(new) end);
  return null;
end $$;
create trigger templates_log after insert or update on public.task_templates
  for each row execute function public.log_template();

-- ---------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.households enable row level security;
alter table public.household_members enable row level security;
alter table public.activity_log enable row level security;
alter table public.zones enable row level security;
alter table public.categories enable row level security;
alter table public.task_templates enable row level security;
alter table public.task_occurrences enable row level security;
alter table public.unavailabilities enable row level security;
alter table public.swap_requests enable row level security;
alter table public.comments enable row level security;
alter table public.maintenance enable row level security;
alter table public.expenses enable row level security;
alter table public.recurring_expenses enable row level security;
alter table public.expense_shares enable row level security;
alter table public.reimbursements enable row level security;
alter table public.budgets enable row level security;
alter table public.stocks enable row level security;
alter table public.shopping_items enable row level security;
alter table public.notifications enable row level security;

-- Profils : soi-même ou l'autre membre de sa colocation ; modification de son propre profil uniquement.
create policy profiles_select on public.profiles for select using (
  id = auth.uid() or exists (
    select 1 from public.household_members m
    where m.user_id = profiles.id and public.is_member(m.household_id)
  )
);
create policy profiles_update on public.profiles for update using (id = auth.uid()) with check (id = auth.uid());

-- Colocation : lecture et modification par les membres. Création et adhésion via fonctions.
create policy households_select on public.households for select using (public.is_member(id));
create policy households_update on public.households for update using (public.is_member(id)) with check (public.is_member(id));

create policy members_select on public.household_members for select using (public.is_member(household_id));

create policy log_select on public.activity_log for select using (public.is_member(household_id));

-- Tables de données communes : accès complet pour les membres (pas de suppression physique
-- des tables historiques : seules les tables sans historique autorisent DELETE).
do $$
declare t text;
begin
  foreach t in array array['zones','categories','task_templates','task_occurrences','unavailabilities',
    'swap_requests','maintenance','recurring_expenses','reimbursements','budgets','stocks','shopping_items','comments'] loop
    execute format('create policy %I on public.%I for select using (public.is_member(household_id))', t || '_select', t);
    execute format('create policy %I on public.%I for insert with check (public.is_member(household_id))', t || '_insert', t);
    execute format('create policy %I on public.%I for update using (public.is_member(household_id)) with check (public.is_member(household_id))', t || '_update', t);
  end loop;
  foreach t in array array['unavailabilities','budgets','stocks','recurring_expenses'] loop
    execute format('create policy %I on public.%I for delete using (public.is_member(household_id))', t || '_delete', t);
  end loop;
end $$;

-- Occurrences : seules les propositions non validées peuvent être supprimées (abandon d'une proposition)
create policy task_occurrences_delete on public.task_occurrences for delete
  using (public.is_member(household_id) and proposed and status = 'todo');

-- Commentaires : on ne peut écrire qu'en son nom
drop policy comments_insert on public.comments;
create policy comments_insert on public.comments for insert
  with check (public.is_member(household_id) and user_id = auth.uid());
drop policy comments_update on public.comments;

-- Indisponibilités : chacune gère les siennes
drop policy unavailabilities_insert on public.unavailabilities;
drop policy unavailabilities_update on public.unavailabilities;
drop policy unavailabilities_delete on public.unavailabilities;
create policy unavailabilities_insert on public.unavailabilities for insert
  with check (public.is_member(household_id) and user_id = auth.uid());
create policy unavailabilities_delete on public.unavailabilities for delete
  using (public.is_member(household_id) and user_id = auth.uid());

-- Demandes d'échange : création par la demandeuse ; réponse via respond_swap().
drop policy swap_requests_insert on public.swap_requests;
drop policy swap_requests_update on public.swap_requests;
create policy swap_requests_insert on public.swap_requests for insert
  with check (public.is_member(household_id) and from_user = auth.uid() and status = 'pending');
create policy swap_requests_update on public.swap_requests for update
  using (public.is_member(household_id) and from_user = auth.uid() and status = 'pending')
  with check (status = 'cancelled');

-- Dépenses : lecture et modification par les membres ; création et parts via save_expense()
create policy expenses_select on public.expenses for select using (public.is_member(household_id));
create policy shares_select on public.expense_shares for select using (public.is_member(household_id));

-- Notifications : chacune ne voit que les siennes
create policy notifications_select on public.notifications for select using (user_id = auth.uid());
create policy notifications_update on public.notifications for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------------------------------------------------------------------
-- Fonctions appelées par l'application (opérations transactionnelles)
-- ---------------------------------------------------------------------
-- Code d'invitation à 8 caractères (sans dépendre de pgcrypto, installé dans le schéma « extensions » sur Supabase)
create or replace function public.random_code() returns text language sql volatile set search_path = pg_catalog as $$
  select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 1 + floor(random() * 32)::int, 1), '')
  from generate_series(1, 8);
$$;

create or replace function public.create_household(p_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  hid uuid;
  uid uuid := auth.uid();
  z record;
begin
  if uid is null then raise exception 'Connexion requise.' using errcode = 'P0001'; end if;
  if exists (select 1 from public.household_members where user_id = uid) then
    raise exception 'Vous faites déjà partie d''une colocation.' using errcode = 'P0001';
  end if;
  insert into public.profiles (id) values (uid) on conflict do nothing;
  insert into public.households (name, invite_code, created_by, settings)
  values (p_name, public.random_code(), uid, jsonb_build_object(
    'effort_coef', jsonb_build_object('light', 1.0, 'moderate', 1.2, 'heavy', 1.5),
    'default_split', 'equal',
    'enable_in_progress', false,
    'avoid_repeats', true,
    'window_weeks', 4))
  returning id into hid;
  insert into public.household_members (household_id, user_id, role) values (hid, uid, 'owner');

  insert into public.zones (household_id, name, icon, position) values
    (hid, 'Cuisine', '🍳', 1), (hid, 'Salle de bain', '🛁', 2), (hid, 'WC', '🚽', 3),
    (hid, 'Salon', '🛋️', 4), (hid, 'Entrée', '🚪', 5), (hid, 'Balcon / terrasse', '🌿', 6);

  insert into public.categories (household_id, kind, name, position)
  select hid, 'expense', n, i from unnest(array['Courses alimentaires','Produits ménagers','Loyer','Électricité et gaz',
    'Eau','Internet','Assurance habitation','Mobilier et équipement','Réparations et entretien','Autres dépenses'])
    with ordinality as t(n, i);
  insert into public.categories (household_id, kind, name, position)
  select hid, 'shopping', n, i from unnest(array['Alimentation','Produits ménagers','Hygiène et salle de bain',
    'Consommables','Équipement','Autres']) with ordinality as t(n, i);

  -- Tâches d'exemple (modifiables, archivables)
  for z in select id, name from public.zones where household_id = hid loop
    insert into public.task_templates (household_id, zone_id, name, frequency, weekdays, month_week, duration_min, effort, created_by)
    select hid, z.id, t.name, t.freq, t.days, t.mw, t.dur, t.eff, uid
    from (values
      ('Cuisine', 'Vaisselle et plans de travail', 'daily', '{}'::int[], null::int, 15, 'light'),
      ('Cuisine', 'Sortir les poubelles', 'weekly', '{1,4}'::int[], null::int, 5, 'light'),
      ('Cuisine', 'Nettoyer les plaques', 'weekly', '{3}'::int[], null::int, 10, 'moderate'),
      ('Cuisine', 'Laver le sol de la cuisine', 'weekly', '{6}'::int[], null::int, 15, 'moderate'),
      ('Salle de bain', 'Nettoyer la douche', 'weekly', '{6}'::int[], null::int, 20, 'heavy'),
      ('Salle de bain', 'Lavabo et miroir', 'weekly', '{3}'::int[], null::int, 10, 'light'),
      ('Salle de bain', 'Sol de la salle de bain', 'weekly', '{6}'::int[], null::int, 10, 'moderate'),
      ('WC', 'Nettoyer la cuvette et désinfecter', 'weekly', '{2,6}'::int[], null::int, 10, 'heavy'),
      ('Salon', 'Ranger et dépoussiérer', 'weekly', '{5}'::int[], null::int, 15, 'light'),
      ('Salon', 'Aspirer le salon', 'weekly', '{6}'::int[], null::int, 20, 'moderate'),
      ('Entrée', 'Ranger les chaussures et nettoyer le sol', 'weekly', '{7}'::int[], null::int, 10, 'light'),
      ('Balcon / terrasse', 'Balayer le balcon', 'weekly', '{7}'::int[], null::int, 15, 'moderate'),
      ('Salon', 'Laver les vitres', 'monthly', '{6}'::int[], 1, 45, 'heavy'),
      ('Cuisine', 'Nettoyer le four', 'monthly', '{6}'::int[], 2, 30, 'heavy'),
      ('Cuisine', 'Nettoyer le micro-ondes', 'monthly', '{6}'::int[], 3, 10, 'moderate'),
      ('Cuisine', 'Nettoyer le frigo', 'monthly', '{6}'::int[], 4, 25, 'heavy')
    ) as t(zone, name, freq, days, mw, dur, eff)
    where t.zone = z.name;
  end loop;

  perform public.log_action(hid, 'household', hid, 'create', jsonb_build_object('name', p_name));
  return hid;
end $$;

-- Aperçu d'une invitation (nom de la colocation) avant de l'accepter.
create or replace function public.peek_invite(p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare h record;
begin
  if auth.uid() is null then raise exception 'Connexion requise.' using errcode = 'P0001'; end if;
  select id, name, created_by into h from public.households where invite_code = upper(trim(p_code));
  if h.id is null then raise exception 'Invitation introuvable ou expirée.' using errcode = 'P0001'; end if;
  return jsonb_build_object('name', h.name, 'from', public.display_name(h.created_by),
    'full', (select count(*) from public.household_members where household_id = h.id) >= 2);
end $$;

create or replace function public.join_household(p_code text) returns uuid
language plpgsql security definer set search_path = public as $$
declare hid uuid; uid uuid := auth.uid();
begin
  if uid is null then raise exception 'Connexion requise.' using errcode = 'P0001'; end if;
  select id into hid from public.households where invite_code = upper(trim(p_code));
  if hid is null then raise exception 'Invitation introuvable ou expirée.' using errcode = 'P0001'; end if;
  if exists (select 1 from public.household_members where user_id = uid) then
    raise exception 'Vous faites déjà partie d''une colocation.' using errcode = 'P0001';
  end if;
  insert into public.profiles (id) values (uid) on conflict do nothing;
  insert into public.household_members (household_id, user_id, role) values (hid, uid, 'member');
  -- l'invitation devient inutilisable une fois la colocation complète
  update public.households set invite_code = null where id = hid;
  perform public.log_action(hid, 'household', hid, 'join', '{}'::jsonb);
  perform public.notify(hid, public.other_member(hid, uid), 'member', public.display_name(uid) || ' a rejoint la colocation', '', '/');
  return hid;
end $$;

create or replace function public.regenerate_invite() returns text
language plpgsql security definer set search_path = public as $$
declare hid uuid := public.my_household(); code text;
begin
  if hid is null then raise exception 'Aucune colocation.' using errcode = 'P0001'; end if;
  if (select count(*) from public.household_members where household_id = hid) >= 2 then
    raise exception 'La colocation est complète.' using errcode = 'P0001';
  end if;
  code := public.random_code();
  update public.households set invite_code = code where id = hid;
  return code;
end $$;

create or replace function public.transfer_owner(p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
declare hid uuid := public.my_household();
begin
  if not exists (select 1 from public.household_members where household_id = hid and user_id = auth.uid() and role = 'owner') then
    raise exception 'Seule la personne gestionnaire peut transférer ce rôle.' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.household_members where household_id = hid and user_id = p_user) then
    raise exception 'Personne inconnue.' using errcode = 'P0001';
  end if;
  update public.household_members set role = 'member' where household_id = hid and user_id = auth.uid();
  update public.household_members set role = 'owner' where household_id = hid and user_id = p_user;
  perform public.log_action(hid, 'household', hid, 'transfer_owner', jsonb_build_object('to', p_user));
end $$;

-- Quitter : les données communes et l'historique restent ; le rôle passe à l'autre membre.
create or replace function public.leave_household() returns void
language plpgsql security definer set search_path = public as $$
declare hid uuid := public.my_household(); uid uuid := auth.uid(); other uuid;
begin
  if hid is null then return; end if;
  other := public.other_member(hid, uid);
  perform public.log_action(hid, 'household', hid, 'leave', '{}'::jsonb);
  -- les tâches futures non terminées ne sont plus attribuées
  update public.task_occurrences set assigned_to = null
    where household_id = hid and assigned_to = uid and status in ('todo', 'in_progress', 'postponed') and due_date >= current_date;
  update public.swap_requests set status = 'cancelled' where household_id = hid and status = 'pending';
  delete from public.household_members where household_id = hid and user_id = uid;
  if other is not null then
    update public.household_members set role = 'owner' where household_id = hid and user_id = other;
    update public.households set invite_code = public.random_code() where id = hid;
  end if;
end $$;

-- Suppression du compte : le profil est anonymisé (l'historique commun reste cohérent).
create or replace function public.delete_my_account() returns void
language plpgsql security definer set search_path = public, auth as $$
declare uid uuid := auth.uid();
begin
  if uid is null then return; end if;
  perform public.leave_household();
  update public.profiles set display_name = 'Ancien membre', deleted = true, notif_prefs = '{}', ui_prefs = '{}' where id = uid;
  delete from public.notifications where user_id = uid;
  delete from auth.users where id = uid;
end $$;

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

-- Changement de statut seul (valider / annuler) sans toucher aux parts.
create or replace function public.set_expense_status(p_id uuid, p_status text, p_version int) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.expenses set status = p_status
  where id = p_id and household_id = public.my_household() and version = p_version;
  if not found then
    raise exception 'Cette dépense a été modifiée entre-temps. Rechargez puis réessayez.' using errcode = 'P0002';
  end if;
end $$;

-- Réponse à une demande d'échange : seule la destinataire peut répondre.
create or replace function public.respond_swap(p_id uuid, p_accept boolean) returns void
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  select * into r from public.swap_requests where id = p_id for update;
  if r.id is null or not public.is_member(r.household_id) then
    raise exception 'Demande introuvable.' using errcode = 'P0001';
  end if;
  if r.to_user <> auth.uid() then
    raise exception 'Seule la personne sollicitée peut répondre.' using errcode = 'P0001';
  end if;
  if r.status <> 'pending' then
    raise exception 'Cette demande a déjà reçu une réponse.' using errcode = 'P0001';
  end if;
  update public.swap_requests set status = case when p_accept then 'accepted' else 'refused' end, responded_at = now()
  where id = p_id;
  if p_accept then
    update public.task_occurrences set assigned_to = r.to_user, locked = true
    where id = r.occurrence_id;
  end if;
end $$;

-- Droits des rôles : les visiteurs non connectés (anon) n'accèdent à rien ;
-- les comptes connectés passent ensuite par les règles RLS ci-dessus.
revoke all on all tables in schema public from anon;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;

-- Accès des rôles aux fonctions
revoke execute on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
revoke execute on function public.notify(uuid, uuid, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.log_action(uuid, text, uuid, text, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Synchronisation en temps réel
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['households','household_members','profiles','zones','categories','task_templates',
      'task_occurrences','unavailabilities','swap_requests','comments','maintenance','expenses','expense_shares',
      'reimbursements','budgets','stocks','shopping_items','notifications','recurring_expenses'] loop
      execute format('alter publication supabase_realtime add table public.%I', t);
    end loop;
  end if;
end $$;
