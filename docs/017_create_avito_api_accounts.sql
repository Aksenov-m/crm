-- 017. Stores Avito app credentials encrypted by the backend before they reach PostgreSQL.
begin;

create table avito_api_accounts (
  account_key text primary key check (account_key ~ '^[a-zA-Z0-9_-]{1,40}$'),
  owner_id uuid not null references app_users(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 80),
  credentials_ciphertext text not null check (length(credentials_ciphertext) between 1 and 4096),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index avito_api_accounts_owner_created_idx
  on avito_api_accounts(owner_id, created_at);

commit;
