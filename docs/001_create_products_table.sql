-- 001. Товары личной CRM. Выполнить один раз в SQL Editor НОВОГО проекта Supabase.
-- Таблица, права и RLS создаются одной транзакцией: открытого промежуточного состояния нет.
-- Supabase управляет auth.users; owner_id всегда относится к пользователю CRM,
-- а не к идентификатору аккаунта Авито. Секретов интеграций в этой таблице нет.
begin;

create table public.products (
  id uuid primary key default gen_random_uuid(), -- Внутренний ID товара.
  owner_id uuid not null default auth.uid()
    references auth.users (id) on delete cascade,
  title text not null check (length(btrim(title)) > 0),
  description text not null default '',
  price numeric(14, 2) not null default 0
    check (price >= 0 and price < 1000000000000), -- Рубли, 2 знака; NaN не допускается.
  image_path text, -- Путь объекта в будущем хранилище фото; не base64 и не временный signed URL.
  stage text not null default 'new'
    check (stage in ('new', 'preparing', 'ready', 'published', 'sold')),
  category text not null check (length(btrim(category)) > 0),
  views integer not null default 0 check (views >= 0),
  favorites integer not null default 0 check (favorites >= 0),
  created_at timestamptz not null default now(),
  sold_at timestamptz, -- При переводе в sold установить дату, при выходе из sold сбросить в null.
  constraint products_sale_date_check check ((stage = 'sold') = (sold_at is not null)),
  constraint products_id_owner_unique unique (id, owner_id)
);

comment on table public.products is
  'Товары CRM. owner_id = auth.users.id. views/favorites пока локальные показатели; состояние stage не подтверждает публикацию через Авито.';
comment on column public.products.image_path is
  'Необязательный путь к фото. Storage и загрузка файлов настраиваются отдельным этапом. Временные signed URL не сохранять.';
create index products_owner_created_idx on public.products (owner_id, created_at desc);

alter table public.products enable row level security;
revoke all on table public.products from public, anon, authenticated;
grant select, insert, update, delete on table public.products to authenticated;
grant select, insert, update, delete on table public.products to service_role;

create policy products_owner_select on public.products for select to authenticated
  using ((select auth.uid()) = owner_id);
create policy products_owner_insert on public.products for insert to authenticated
  with check ((select auth.uid()) = owner_id);
create policy products_owner_update on public.products for update to authenticated
  using ((select auth.uid()) = owner_id)
  with check ((select auth.uid()) = owner_id);
create policy products_owner_delete on public.products for delete to authenticated
  using ((select auth.uid()) = owner_id);

commit;
