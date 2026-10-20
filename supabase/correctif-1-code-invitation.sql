-- Correctif n°1 — à exécuter une fois dans Supabase > SQL Editor > New query > Run.
-- Corrige l'erreur à la création de la colocation : la génération du code d'invitation
-- utilisait gen_random_bytes (pgcrypto), introuvable depuis les fonctions sécurisées.
-- Code d'invitation à 8 caractères (sans dépendre de pgcrypto, installé dans le schéma « extensions » sur Supabase)
create or replace function public.random_code() returns text language sql volatile set search_path = pg_catalog as $$
  select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 1 + floor(random() * 32)::int, 1), '')
  from generate_series(1, 8);
$$;
