-- 013. Черновики публикаций CRM в Авито через Автозагрузку.
-- Выполнить целиком после 001 и 005. Токены Авито в таблицу не записываются.
begin;

create table public.avito_publications (
  owner_id uuid not null references auth.users(id) on delete cascade,
  account_key text not null check (account_key ~ '^[a-zA-Z0-9_-]{1,40}$'),
  product_id uuid not null,
  status text not null default 'pending' check (status in ('pending', 'active', 'error')),
  address text not null check (length(btrim(address)) between 1 and 500),
  manager_name text not null check (length(btrim(manager_name)) between 1 and 120),
  contact_phone text not null check (length(btrim(contact_phone)) between 1 and 40),
  report_email text check (report_email is null or length(btrim(report_email)) between 3 and 200),
  avito_id text,
  avito_url text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, account_key, product_id),
  foreign key (product_id, owner_id) references public.products(id, owner_id) on delete cascade
);

comment on table public.avito_publications is
  'Товары, переданные в Авито Автозагрузку. Actual publication is confirmed only by the Avito upload report.';
comment on column public.avito_publications.product_id is
  'Stable Id is emitted into the XML feed so Avito can update the same listing instead of creating a duplicate.';

create index avito_publications_owner_status_idx on public.avito_publications(owner_id, account_key, status, created_at);

alter table public.avito_publications enable row level security;
revoke all on public.avito_publications from public, anon;
grant select, insert, update, delete on public.avito_publications to authenticated;
grant all on public.avito_publications to service_role;

create policy avito_publications_owner_select on public.avito_publications for select to authenticated
  using ((select auth.uid()) = owner_id);
create policy avito_publications_owner_insert on public.avito_publications for insert to authenticated
  with check ((select auth.uid()) = owner_id);
create policy avito_publications_owner_update on public.avito_publications for update to authenticated
  using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
create policy avito_publications_owner_delete on public.avito_publications for delete to authenticated
  using ((select auth.uid()) = owner_id);

commit;
