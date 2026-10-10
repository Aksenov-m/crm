-- 015. Полная схема собственной CRM на PostgreSQL, без Supabase.
-- Создаётся при первом запуске контейнера backend. Существующую базу Supabase
-- этот файл не читает и не изменяет.
begin;

create table crm_schema_migrations (
  name text primary key,
  applied_at timestamptz not null default now()
);

create table app_users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique check (length(btrim(email)) between 3 and 320),
  password_hash text not null,
  created_at timestamptz not null default now()
);

create table app_sessions (
  token_hash text primary key check (token_hash ~ '^[a-f0-9]{64}$'),
  user_id uuid not null references app_users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index app_sessions_expiry_idx on app_sessions(expires_at);

create table products (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references app_users(id) on delete cascade,
  title text not null check (length(btrim(title)) > 0),
  description text not null default '',
  price numeric(14,2) not null default 0 check (price >= 0 and price < 1000000000000),
  image_path text,
  stage text not null default 'new' check (stage in ('new','preparing','ready','published','sold')),
  category text not null check (length(btrim(category)) > 0),
  views integer not null default 0 check (views >= 0),
  favorites integer not null default 0 check (favorites >= 0),
  created_at timestamptz not null default now(),
  sold_at timestamptz,
  constraint products_sale_date_check check ((stage = 'sold') = (sold_at is not null)),
  constraint products_id_owner_unique unique (id, owner_id)
);
create index products_owner_created_idx on products(owner_id, created_at desc);

create table buyers (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references app_users(id) on delete cascade,
  name text not null check (length(btrim(name)) > 0),
  phone text not null default '',
  product_id uuid,
  status text not null default 'new' check (status in ('new','negotiation','sale','rejected')),
  note text not null default '',
  created_at timestamptz not null default now(),
  constraint buyers_id_owner_unique unique (id, owner_id),
  constraint buyers_product_owner_fk foreign key (product_id, owner_id)
    references products(id, owner_id) on delete no action
);
create index buyers_owner_product_idx on buyers(owner_id, product_id);

create table messages (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references app_users(id) on delete cascade,
  buyer_id uuid not null,
  text text not null check (length(btrim(text)) > 0),
  direction text not null check (direction in ('incoming','outgoing')),
  created_at timestamptz not null default now(),
  read boolean not null default false,
  constraint messages_buyer_owner_fk foreign key (buyer_id, owner_id)
    references buyers(id, owner_id) on delete no action
);
create index messages_owner_buyer_created_idx on messages(owner_id, buyer_id, created_at);

create table avito_item_links (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references app_users(id) on delete cascade,
  account_id text not null check (account_id ~ '^[1-9][0-9]{0,18}$'),
  item_id text not null check (item_id ~ '^[1-9][0-9]{0,18}$'),
  product_id uuid not null,
  avito_title text not null check (length(btrim(avito_title)) between 1 and 1000),
  avito_status text not null check (length(avito_status) between 1 and 100),
  avito_url text,
  linked_at timestamptz not null default now(),
  constraint avito_item_links_product_owner_fk foreign key (product_id, owner_id)
    references products(id, owner_id) on delete cascade,
  constraint avito_item_links_owner_account_item_unique unique(owner_id, account_id, item_id)
);
create index avito_item_links_owner_product_idx on avito_item_links(owner_id, product_id);

create table avito_messenger_accounts (
  owner_id uuid not null references app_users(id) on delete cascade,
  account_key text not null check (account_key ~ '^[a-zA-Z0-9_-]{1,40}$'),
  avito_user_id text not null check (avito_user_id ~ '^[1-9][0-9]{0,18}$'),
  webhook_enabled boolean not null default false,
  registered_at timestamptz,
  last_event_at timestamptz,
  primary key(owner_id, account_key)
);

create table avito_messenger_messages (
  owner_id uuid not null,
  account_key text not null,
  avito_user_id text not null,
  chat_id text not null check (length(chat_id) between 1 and 200),
  message_id text not null check (length(message_id) between 1 and 200),
  created bigint not null check (created between 0 and 1000000000000),
  message jsonb not null check (jsonb_typeof(message) = 'object'),
  updated_at timestamptz not null default now(),
  primary key(owner_id, account_key, avito_user_id, chat_id, message_id),
  foreign key(owner_id, account_key) references avito_messenger_accounts(owner_id, account_key) on delete cascade
);
create index avito_messenger_history_idx
  on avito_messenger_messages(owner_id, account_key, chat_id, created desc, message_id desc);

create table avito_oauth_states (
  owner_id uuid not null references app_users(id) on delete cascade,
  account_key text not null check (account_key ~ '^[a-zA-Z0-9_-]{1,40}$'),
  state_hash text not null check (state_hash ~ '^[a-f0-9]{64}$'),
  redirect_uri text not null,
  expires_at timestamptz not null,
  primary key(owner_id, state_hash)
);
create index avito_oauth_states_expiry_idx on avito_oauth_states(expires_at);

create table avito_oauth_tokens (
  owner_id uuid not null references app_users(id) on delete cascade,
  account_key text not null check (account_key ~ '^[a-zA-Z0-9_-]{1,40}$'),
  access_token text not null,
  refresh_token text not null,
  token_type text not null default 'Bearer' check (lower(token_type) = 'bearer'),
  expires_at timestamptz not null,
  scope text,
  updated_at timestamptz not null default now(),
  primary key(owner_id, account_key)
);

create table avito_publications (
  owner_id uuid not null references app_users(id) on delete cascade,
  account_key text not null check (account_key ~ '^[a-zA-Z0-9_-]{1,40}$'),
  product_id uuid not null,
  status text not null default 'pending' check (status in ('pending','active','error')),
  address text not null check (length(btrim(address)) between 1 and 500),
  manager_name text not null check (length(btrim(manager_name)) between 1 and 120),
  contact_phone text not null check (length(btrim(contact_phone)) between 1 and 40),
  report_email text check (report_email is null or length(btrim(report_email)) between 3 and 200),
  avito_id text,
  avito_url text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(owner_id, account_key, product_id),
  foreign key(product_id, owner_id) references products(id, owner_id) on delete cascade
);
create index avito_publications_owner_status_idx
  on avito_publications(owner_id, account_key, status, created_at);

create function notify_avito_messenger_change() returns trigger
language plpgsql as $$
declare row_data record;
begin
  if TG_OP = 'DELETE' then row_data := OLD; else row_data := NEW; end if;
  perform pg_notify('crm_messenger', json_build_object(
    'owner_id', row_data.owner_id,
    'account_key', row_data.account_key,
    'chat_id', row_data.chat_id
  )::text);
  if TG_OP = 'DELETE' then return OLD; end if;
  return NEW;
end;
$$;
create trigger avito_messenger_notify
  after insert or update or delete on avito_messenger_messages
  for each row execute function notify_avito_messenger_change();

commit;
