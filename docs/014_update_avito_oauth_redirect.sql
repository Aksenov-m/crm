-- 014. Use the production OAuth callback exactly as registered in Avito.
-- Run after 011_create_avito_oauth.sql and 012_allow_local_avito_oauth_redirect.sql
-- in projects where the OAuth tables already exist.
begin;

-- Старые состояния нельзя перенести на новый redirect_uri: Avito требует,
-- чтобы URI при обмене кода совпадал с URI из исходного запроса авторизации.
delete from public.avito_oauth_states
 where redirect_uri = 'https://proaksenov.ru/api/avito/callback';

alter table public.avito_oauth_states
  drop constraint if exists avito_oauth_states_redirect_uri_check;

alter table public.avito_oauth_states
  add constraint avito_oauth_states_redirect_uri_check
  check (redirect_uri in (
    'https://proaksenov.ru/api/avito/callback,',
    'http://127.0.0.1:3000/api/avito/callback'
  ));

commit;
