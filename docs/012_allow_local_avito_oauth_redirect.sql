-- 012. Allow the callback used by the local Next.js dev server.
-- Run after 011_create_avito_oauth.sql in an existing Supabase project.
begin;

alter table public.avito_oauth_states
  drop constraint if exists avito_oauth_states_redirect_uri_check;

alter table public.avito_oauth_states
  add constraint avito_oauth_states_redirect_uri_check
  check (redirect_uri in (
    'https://proaksenov.ru/api/avito/callback',
    'http://127.0.0.1:3000/api/avito/callback'
  ));

commit;
