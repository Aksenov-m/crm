-- 002. Покупатели. Выполнить после 001_create_products_table.sql.
-- product_id = null, если покупатель пока не связан с товаром (в демо это пустая строка).
begin;

create table public.buyers (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid()
    references auth.users (id) on delete cascade,
  name text not null check (length(btrim(name)) > 0),
  phone text not null default '', -- Телефон хранится строкой; может отсутствовать.
  product_id uuid, -- Необязательная связь с ОДНИМ товаром, как в текущем интерфейсе.
  status text not null default 'new'
    check (status in ('new', 'negotiation', 'sale', 'rejected')),
  note text not null default '',
  created_at timestamptz not null default now(),
  constraint buyers_id_owner_unique unique (id, owner_id),
  constraint buyers_product_owner_fk foreign key (product_id, owner_id)
    references public.products (id, owner_id) on delete no action
);

comment on table public.buyers is
  'Контакты CRM. Составной внешний ключ запрещает привязку к товару другого владельца. Перед удалением товара отвязать покупателей (product_id = null).';
create index buyers_owner_product_idx on public.buyers (owner_id, product_id);

alter table public.buyers enable row level security;
revoke all on table public.buyers from public, anon, authenticated;
grant select, insert, update, delete on table public.buyers to authenticated;
grant select, insert, update, delete on table public.buyers to service_role;

create policy buyers_owner_select on public.buyers for select to authenticated
  using ((select auth.uid()) = owner_id);
create policy buyers_owner_insert on public.buyers for insert to authenticated
  with check ((select auth.uid()) = owner_id);
create policy buyers_owner_update on public.buyers for update to authenticated
  using ((select auth.uid()) = owner_id)
  with check ((select auth.uid()) = owner_id);
create policy buyers_owner_delete on public.buyers for delete to authenticated
  using ((select auth.uid()) = owner_id);

commit;
