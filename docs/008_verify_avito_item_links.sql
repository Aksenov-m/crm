-- 008. Проверка привязки Авито после 007. Выполнить целиком в SQL Editor как postgres.
-- Временные пользователи/товары/связи откатываются. Это проверка БД, а не доступа к API Авито.
begin;
select set_config('avito_test.owner_a', gen_random_uuid()::text, true);
select set_config('avito_test.owner_b', gen_random_uuid()::text, true);
insert into auth.users(id) values
  (current_setting('avito_test.owner_a')::uuid), (current_setting('avito_test.owner_b')::uuid);
set local role authenticated;
select set_config('request.jwt.claim.sub', current_setting('avito_test.owner_a'), true);
do $$
declare
  first_product uuid;
  repeated_product uuid;
  custom_product uuid;
  other_product uuid;
begin
  first_product := public.connect_avito_item('1001', '2001', 'Тестовый товар', 125.50, 'Мебель', 'active', null);
  repeated_product := public.connect_avito_item('1001', '2001', 'Повтор', 500, 'Другое', 'removed', null);
  if first_product <> repeated_product then raise exception 'FAIL: повторный импорт создал второй товар'; end if;
  if (select count(*) from public.products) <> 1 then raise exception 'FAIL: число товаров после повторного импорта'; end if;
  if not exists(select 1 from public.products where id = first_product and title = 'Тестовый товар' and price = 125.50 and stage = 'published') then raise exception 'FAIL: импортированные поля'; end if;
  perform set_config('avito_test.product_a', first_product::text, true);
  insert into public.products(title, price, category, stage, sold_at)
    values ('Мой текст', 400, 'Другое', 'sold', now()) returning id into custom_product;
  perform public.connect_avito_item('1001', '2002', 'Текст Авито', 999, 'Мебель', 'active', null, custom_product);
  if not exists(select 1 from public.products where id = custom_product and title = 'Мой текст' and price = 400 and stage = 'sold') then raise exception 'FAIL: привязка перезаписала товар'; end if;
  begin
    perform public.connect_avito_item('1001', '2001', 'Смена товара', 10, 'Другое', 'active', null, custom_product);
    raise exception 'FAIL: существующая связь была незаметно изменена';
  exception when unique_violation then null; end;
  begin
    insert into public.avito_item_links(owner_id, account_id, item_id, product_id, avito_title, avito_status)
      values (current_setting('avito_test.owner_b')::uuid, '1001', '2003', first_product, 'Подмена владельца', 'active');
    raise exception 'FAIL: подмена owner_id';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claim.sub', current_setting('avito_test.owner_b'), true);
  if exists(select 1 from public.avito_item_links) then raise exception 'FAIL: видны чужие связи'; end if;
  begin
    perform public.connect_avito_item('1001', '2004', 'Чужой товар', 10, 'Другое', 'active', null, first_product);
    raise exception 'FAIL: связь с чужим товаром';
  exception when foreign_key_violation then null; end;
  begin
    insert into public.avito_item_links(account_id, item_id, product_id, avito_title, avito_status)
      values ('1001', '2004', first_product, 'Чужой товар напрямую', 'active');
    raise exception 'FAIL: прямая связь с чужим товаром';
  exception when foreign_key_violation then null; end;
  other_product := public.connect_avito_item('1001', '2001', 'Другой владелец', 1, 'Другое', 'removed', null);
  if other_product = first_product then raise exception 'FAIL: импорт использовал чужой товар'; end if;
  if not exists(select 1 from public.products where id = other_product and stage = 'new' and sold_at is null) then raise exception 'FAIL: снятый товар ошибочно продан'; end if;
  update public.avito_item_links set avito_title = 'Своя правка' where product_id = other_product;
  if not found then raise exception 'FAIL: нельзя обновить свою связь'; end if;
  update public.avito_item_links set avito_title = 'Чужая правка' where product_id = first_product;
  if found then raise exception 'FAIL: изменена чужая связь'; end if;
  delete from public.avito_item_links where product_id = first_product;
  if found then raise exception 'FAIL: удалена чужая связь'; end if;
  delete from public.products where id = other_product;
  if exists(select 1 from public.avito_item_links where product_id = other_product) then raise exception 'FAIL: каскадное удаление связи'; end if;
end;
$$;
reset role;
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
do $$
begin
  begin
    perform * from public.avito_item_links;
    raise exception 'FAIL: анонимное чтение';
  exception when insufficient_privilege then null; end;
  begin
    perform public.connect_avito_item('1', '2', 'Анонимный импорт', 1, 'Другое', 'active', null);
    raise exception 'FAIL: анонимный импорт';
  exception when insufficient_privilege then null; end;
end;
$$;
reset role;
select 'PASS: Avito links, idempotent import, preserved local edits, owner isolation and anonymous denial' as result;
rollback;
