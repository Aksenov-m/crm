-- 005. Приватные фотографии товаров. Выполнить целиком один раз после 001-004
-- в SQL Editor проекта Supabase (роль postgres).
-- Bucket product-images ещё не должен существовать: конфликт отменит всю транзакцию.
-- Формат пути приложения: <auth.uid()>/<product UUID>/<random UUID>.jpg.
-- Здесь создаётся конфигурация bucket и политики; сами файлы загружаются через Storage API.
-- Управляемые таблицы Storage, их владельцы, RLS и GRANT не изменяются.
begin;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'product-images',
  'product-images',
  false,
  5242880, -- 5 MiB; ограничения размера и MIME проверяет Storage API.
  array['image/jpeg', 'image/png', 'image/webp']
);

create policy product_images_owner_select
  on storage.objects for select to authenticated
  using (
    bucket_id = 'product-images'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy product_images_owner_insert
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'product-images'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy product_images_owner_update
  on storage.objects for update to authenticated
  using (
    bucket_id = 'product-images'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  )
  with check (
    bucket_id = 'product-images'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy product_images_owner_delete
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'product-images'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- Любые другие разрешающие политики Storage складываются с этими через OR.
-- Не добавляйте общие публичные политики для product-images; проверяйте доступ файлом 006.
commit;
