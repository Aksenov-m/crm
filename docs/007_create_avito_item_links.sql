-- 007. Связи объявлений Авито и товаров CRM. Выполнить целиком один раз после 001–006.
-- Ключи и токены Авито здесь не хранятся. API вызывает серверная Edge Function.
begin;

create table public.avito_item_links (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  account_id text not null check (account_id ~ '^[1-9][0-9]{0,18}$'),
  item_id text not null check (item_id ~ '^[1-9][0-9]{0,18}$'),
  product_id uuid not null,
  avito_title text not null check (length(btrim(avito_title)) between 1 and 1000),
  avito_status text not null check (length(avito_status) between 1 and 100),
  avito_url text,
  linked_at timestamptz not null default now(),
  constraint avito_item_links_product_owner_fk foreign key (product_id, owner_id)
    references public.products(id, owner_id) on delete cascade,
  constraint avito_item_links_owner_account_item_unique unique(owner_id, account_id, item_id)
);
comment on table public.avito_item_links is 'Связи товаров CRM с объявлениями Авито. Снимок названия/статуса на момент привязки, не автоматическая синхронизация. Ключей и токенов нет.';
comment on column public.avito_item_links.account_id is 'Числовой ID аккаунта Авито, строка для точного хранения. Не auth.users.id.';
comment on column public.avito_item_links.avito_status is 'Статус объявления при привязке. Снятие с Авито не означает продажу товара.';
alter table public.avito_item_links enable row level security;
revoke all on public.avito_item_links from public, anon, authenticated;
grant select, insert, update, delete on public.avito_item_links to authenticated, service_role;
create policy avito_item_links_owner_select on public.avito_item_links for select to authenticated using ((select auth.uid()) = owner_id);
create policy avito_item_links_owner_insert on public.avito_item_links for insert to authenticated with check ((select auth.uid()) = owner_id);
create policy avito_item_links_owner_update on public.avito_item_links for update to authenticated using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
create policy avito_item_links_owner_delete on public.avito_item_links for delete to authenticated using ((select auth.uid()) = owner_id);

-- Атомарное создание товара и связи. Повтор того же импорта не создаёт второй товар.
-- SECURITY INVOKER: действуют RLS и права вызывающего пользователя, обхода RLS нет.
create function public.connect_avito_item(
  p_account_id text, p_item_id text, p_title text, p_price numeric,
  p_category text, p_status text, p_url text, p_product_id uuid default null
) returns uuid language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  owner_uuid uuid := auth.uid();
  linked_product uuid;
begin
  if owner_uuid is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  if p_account_id is null or p_account_id !~ '^[1-9][0-9]{0,18}$'
    or p_item_id is null or p_item_id !~ '^[1-9][0-9]{0,18}$'
    or p_title is null or length(btrim(p_title)) not between 1 and 1000
    or p_category is null or length(btrim(p_category)) not between 1 and 1000
    or p_price is null or not (p_price >= 0 and p_price < 1000000000000)
    or p_status is null or length(p_status) not between 1 and 100 then
    raise exception 'Invalid listing data' using errcode = '23514';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(owner_uuid::text || ':' || p_account_id || ':' || p_item_id, 0));
  select product_id into linked_product from public.avito_item_links
    where owner_id = owner_uuid and account_id = p_account_id and item_id = p_item_id;
  if found then
    if p_product_id is not null and p_product_id <> linked_product then
      raise exception 'Listing already linked to another product' using errcode = '23505';
    end if;
    return linked_product;
  end if;
  if p_product_id is not null then
    select id into linked_product from public.products where id = p_product_id and owner_id = owner_uuid;
    if not found then raise exception 'Product not accessible' using errcode = '23503'; end if;
  else
    insert into public.products (owner_id, title, description, price, category, stage)
      values (owner_uuid, btrim(p_title), '', p_price, btrim(p_category), case when p_status = 'active' then 'published' else 'new' end)
      returning id into linked_product;
  end if;
  insert into public.avito_item_links (owner_id, account_id, item_id, product_id, avito_title, avito_status, avito_url)
    values (owner_uuid, p_account_id, p_item_id, linked_product, btrim(p_title), p_status, p_url);
  return linked_product;
end;
$$;
revoke all on function public.connect_avito_item(text, text, text, numeric, text, text, text, uuid) from public, anon;
grant execute on function public.connect_avito_item(text, text, text, numeric, text, text, text, uuid) to authenticated;
commit;
