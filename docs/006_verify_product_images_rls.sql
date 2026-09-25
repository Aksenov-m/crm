-- 006. Проверка политик приватных фото после 005. Выполнить ВЕСЬ файл в SQL Editor как postgres.
-- Никаких записей в storage.objects и никаких загрузок/удалений файлов здесь НЕТ.
-- Реальные политики и эффективные права копируются во временную таблицу метаданных.
-- Проверяются их SQL-условия с эмуляцией auth.uid(); временная таблица откатывается.
-- Это НЕ проверка HTTP/JWT, Storage API, signed URL, MIME или размера настоящего файла.
-- При ошибке выполните ROLLBACK в этой сессии перед повторным запуском.
begin;

create temporary table product_images_rls_probe
  (like storage.objects including defaults including generated);
alter table product_images_rls_probe enable row level security;
revoke all on table product_images_rls_probe from public, anon, authenticated;

do $copy_configuration$
declare
  policy_row record;
  role_name text;
  operation_name text;
  roles_sql text;
  statement text;
  setting_name text;
begin
  if not exists (
    select 1 from storage.buckets
    where id = 'product-images' and name = 'product-images' and public = false
      and file_size_limit = 5242880
      and allowed_mime_types @> array['image/jpeg', 'image/png', 'image/webp']
      and allowed_mime_types <@ array['image/jpeg', 'image/png', 'image/webp']
  ) then raise exception 'Bucket product-images отсутствует или имеет неверные настройки: выполните 005'; end if;
  if not (select relrowsecurity from pg_class where oid = 'storage.objects'::regclass) then
    raise exception 'На управляемой таблице storage.objects выключен RLS';
  end if;
  if (select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects'
      and policyname in ('product_images_owner_select', 'product_images_owner_insert',
        'product_images_owner_update', 'product_images_owner_delete')) <> 4 then
    raise exception 'Не найдены все четыре политики из 005';
  end if;

  -- Копируем ВСЕ политики, чтобы общая разрешающая политика не скрыла утечку доступа.
  for policy_row in select * from pg_policies where schemaname = 'storage' and tablename = 'objects' loop
    select string_agg(quote_ident(r::text), ', ') into roles_sql from unnest(policy_row.roles) as r;
    statement := format('create policy %I on pg_temp.product_images_rls_probe as %s for %s to %s',
      policy_row.policyname, policy_row.permissive, policy_row.cmd, roles_sql);
    if policy_row.qual is not null then statement := statement || ' using (' || policy_row.qual || ')'; end if;
    if policy_row.with_check is not null then statement := statement || ' with check (' || policy_row.with_check || ')'; end if;
    execute statement;
  end loop;
  execute format('grant usage on schema %I to authenticated, anon', pg_my_temp_schema()::regnamespace::text);
  foreach role_name in array array['authenticated', 'anon'] loop
    foreach operation_name in array array['select', 'insert', 'update', 'delete'] loop
      if has_table_privilege(role_name, 'storage.objects', operation_name) then
        execute format('grant %s on pg_temp.product_images_rls_probe to %I', operation_name, role_name);
      elsif role_name = 'authenticated' then
        raise exception 'На storage.objects отсутствует право % для authenticated', operation_name;
      end if;
    end loop;
  end loop;
  foreach setting_name in array array['owner_a', 'owner_b', 'object_a', 'object_b'] loop
    perform set_config('image_rls.' || setting_name, gen_random_uuid()::text, true);
  end loop;
end
$copy_configuration$;

set local role authenticated;

do $owner_checks$
declare
  suffix text;
  acting_owner uuid;
  object_id uuid;
  object_a uuid := current_setting('image_rls.object_a')::uuid;
  owner_a uuid := current_setting('image_rls.owner_a')::uuid;
  affected bigint;
  forbidden_path text;
begin
  foreach suffix in array array['a', 'b'] loop
    acting_owner := current_setting('image_rls.owner_' || suffix)::uuid;
    object_id := current_setting('image_rls.object_' || suffix)::uuid;
    perform set_config('request.jwt.claim.sub', acting_owner::text, true);
    perform set_config('request.jwt.claims',
      json_build_object('sub', acting_owner, 'role', 'authenticated')::text, true);
    if auth.uid() is distinct from acting_owner then raise exception 'Неверный auth.uid()'; end if;

    insert into pg_temp.product_images_rls_probe (id, bucket_id, name, owner_id, metadata)
      values (object_id, 'product-images', acting_owner || '/' || gen_random_uuid() || '/' || gen_random_uuid() || '.jpg',
        acting_owner::text, '{"rls_test":"initial"}');
    select count(*) into affected from pg_temp.product_images_rls_probe where id = object_id;
    if affected <> 1 then raise exception 'Владелец не читает своё фото'; end if;
    update pg_temp.product_images_rls_probe set metadata = '{"rls_test":"updated"}' where id = object_id;
    get diagnostics affected = row_count;
    if affected <> 1 then raise exception 'Владелец не обновляет своё фото'; end if;
  end loop;

  -- Пользователь B не видит и не меняет фото A.
  select count(*) into affected from pg_temp.product_images_rls_probe where id = object_a;
  if affected <> 0 then raise exception 'Чужое фото доступно для SELECT'; end if;
  update pg_temp.product_images_rls_probe set metadata = '{"rls_test":"stolen"}' where id = object_a;
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'Чужое фото доступно для UPDATE'; end if;
  delete from pg_temp.product_images_rls_probe where id = object_a;
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'Чужое фото доступно для DELETE'; end if;

  foreach forbidden_path in array array[
    owner_a || '/product/forged.jpg', 'root.jpg', acting_owner || '-other/product/forged.jpg'
  ] loop
    begin
      insert into pg_temp.product_images_rls_probe (id, bucket_id, name, owner_id)
        values (gen_random_uuid(), 'product-images', forbidden_path, acting_owner::text);
      raise exception 'Разрешена загрузка по чужому/некорректному пути: %', forbidden_path;
    exception when insufficient_privilege then null;
    end;
  end loop;
  begin
    update pg_temp.product_images_rls_probe set name = owner_a || '/product/moved.jpg' where id = object_id;
    raise exception 'Разрешён перенос своего фото в папку другого владельца';
  exception when insufficient_privilege then null;
  end;

  -- Возвращаемся к A: запрещённые изменения не затронули его строку.
  perform set_config('request.jwt.claim.sub', owner_a::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', owner_a, 'role', 'authenticated')::text, true);
  select count(*) into affected from pg_temp.product_images_rls_probe
    where id = object_a and metadata->>'rls_test' = 'updated';
  if affected <> 1 then raise exception 'Фото A изменилось/пропало после запрещённых операций'; end if;
  delete from pg_temp.product_images_rls_probe where id = object_a;
  get diagnostics affected = row_count;
  if affected <> 1 then raise exception 'Владелец не может удалить своё фото'; end if;
end
$owner_checks$;

set local role anon;

do $anonymous_checks$
declare
  object_b uuid := current_setting('image_rls.object_b')::uuid;
  affected bigint;
  statement text;
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  if auth.uid() is not null then raise exception 'Неверный анонимный auth.uid()'; end if;
  -- В Storage возможны GRANT без разрешающих политик: SELECT/UPDATE/DELETE тогда дают 0 строк.
  foreach statement in array array[
    'select * from pg_temp.product_images_rls_probe where id = $1',
    'update pg_temp.product_images_rls_probe set metadata = ''{}'' where id = $1',
    'delete from pg_temp.product_images_rls_probe where id = $1'
  ] loop
    begin
      execute statement using object_b;
      get diagnostics affected = row_count;
      if affected <> 0 then raise exception 'Анонимный доступ разрешён: %', statement; end if;
    exception when insufficient_privilege then null;
    end;
  end loop;
  begin
    insert into pg_temp.product_images_rls_probe (id, bucket_id, name)
      values (gen_random_uuid(), 'product-images', current_setting('image_rls.owner_b') || '/product/anon.jpg');
    raise exception 'Анонимная загрузка разрешена';
  exception when insufficient_privilege then null;
  end;
end
$anonymous_checks$;

reset role;
do $intact_check$
begin
  if not exists (select 1 from pg_temp.product_images_rls_probe
      where id = current_setting('image_rls.object_b')::uuid and metadata->>'rls_test' = 'updated') then
    raise exception 'Анонимная попытка изменила или удалила фото B';
  end if;
end
$intact_check$;
select 'PASS: private bucket configuration and copied Storage RLS; no real files tested' as result;
rollback;
