-- 011. Durable Avito OAuth Authorization Code state and tokens.
-- Run the WHOLE file in Supabase SQL Editor before using the OAuth button.
begin;

create table public.avito_oauth_states (
  owner_id uuid not null references auth.users(id) on delete cascade,
  account_key text not null check (account_key ~ '^[a-zA-Z0-9_-]{1,40}$'),
  state_hash text not null check (state_hash ~ '^[a-f0-9]{64}$'),
  redirect_uri text not null check (redirect_uri in (
    'https://proaksenov.ru/api/avito/callback',
    'http://127.0.0.1:3000/api/avito/callback'
  )),
  expires_at timestamptz not null,
  primary key (owner_id, state_hash)
);
create index avito_oauth_states_expiry_idx on public.avito_oauth_states(expires_at);
comment on table public.avito_oauth_states is 'Short-lived, hashed OAuth state values. The raw state is never stored.';

create table public.avito_oauth_tokens (
  owner_id uuid not null references auth.users(id) on delete cascade,
  account_key text not null check (account_key ~ '^[a-zA-Z0-9_-]{1,40}$'),
  access_token text not null,
  refresh_token text not null,
  token_type text not null default 'Bearer' check (lower(token_type) = 'bearer'),
  expires_at timestamptz not null,
  scope text,
  updated_at timestamptz not null default now(),
  primary key (owner_id, account_key)
);
comment on table public.avito_oauth_tokens is 'Server-only Avito OAuth tokens. Never expose this table to browser roles or Realtime.';

alter table public.avito_oauth_states enable row level security;
alter table public.avito_oauth_tokens enable row level security;
revoke all on public.avito_oauth_states, public.avito_oauth_tokens from public, anon, authenticated;
grant all on public.avito_oauth_states, public.avito_oauth_tokens to service_role;

create function public.avito_consume_oauth_state(p_owner uuid, p_state_hash text)
returns table(account_key text, redirect_uri text)
language plpgsql security definer set search_path = '' as $$
begin
  return query
    delete from public.avito_oauth_states s
     where s.owner_id = p_owner
       and s.state_hash = p_state_hash
       and s.expires_at > now()
    returning s.account_key, s.redirect_uri;
end;
$$;
revoke all on function public.avito_consume_oauth_state(uuid,text) from public, anon, authenticated;
grant execute on function public.avito_consume_oauth_state(uuid,text) to service_role;

commit;
