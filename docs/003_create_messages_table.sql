-- 003. Сообщения CRM. Выполнить после 002_create_buyers_table.sql.
-- Это хранение сообщений существующего демо, а НЕ подключение к мессенджеру Авито.
-- Будущая интеграция потребует отдельных сущностей аккаунтов/чатов, внешних ID и статусов отправки.
begin;

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid()
    references auth.users (id) on delete cascade,
  buyer_id uuid not null,
  text text not null check (length(btrim(text)) > 0),
  direction text not null check (direction in ('incoming', 'outgoing')),
  created_at timestamptz not null default now(),
  read boolean not null default false,
  constraint messages_buyer_owner_fk foreign key (buyer_id, owner_id)
    references public.buyers (id, owner_id) on delete no action
);

comment on table public.messages is
  'Сообщения личной CRM. Запись в таблицу не отправляет сообщение в Авито. Покупатель и сообщение обязаны принадлежать одному владельцу. Удаление покупателя с историей запрещено.';
create index messages_owner_buyer_created_idx on public.messages (owner_id, buyer_id, created_at);

alter table public.messages enable row level security;
revoke all on table public.messages from public, anon, authenticated;
grant select, insert, update, delete on table public.messages to authenticated;
grant select, insert, update, delete on table public.messages to service_role;

create policy messages_owner_select on public.messages for select to authenticated
  using ((select auth.uid()) = owner_id);
create policy messages_owner_insert on public.messages for insert to authenticated
  with check ((select auth.uid()) = owner_id);
create policy messages_owner_update on public.messages for update to authenticated
  using ((select auth.uid()) = owner_id)
  with check ((select auth.uid()) = owner_id);
create policy messages_owner_delete on public.messages for delete to authenticated
  using ((select auth.uid()) = owner_id);

commit;
