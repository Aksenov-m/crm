-- 010. Run after 009 as postgres. Fixtures and all changes are rolled back.
-- Tests owner RLS, no browser writes, account binding, deduplication, tombstones and receipts.
begin;
select set_config('avito_test.owner_a', gen_random_uuid()::text, true);
select set_config('avito_test.owner_b', gen_random_uuid()::text, true);
insert into auth.users(id) values (current_setting('avito_test.owner_a')::uuid),(current_setting('avito_test.owner_b')::uuid);

set local role service_role;
do $$
declare
  a uuid := current_setting('avito_test.owner_a')::uuid;
  b uuid := current_setting('avito_test.owner_b')::uuid;
  msg jsonb := '{"id":"m1","text":"hello","type":"text","created":1700000000,"direction":"in","isRead":false}';
  stored jsonb;
  n integer;
begin
  perform public.avito_cache_messages(a,'main','12345','chat',jsonb_build_array(msg),false);
  perform public.avito_cache_messages(b,'main','67890','chat',jsonb_build_array(msg),false);
  perform public.avito_cache_messages(a,'main','12345','chat',jsonb_build_array(msg),true);
  select count(*) into n from public.avito_messenger_messages where owner_id=a;
  if n<>1 then raise exception 'Duplicate delivery created duplicate messages'; end if;
  begin
    perform public.avito_cache_messages(a,'main','99999','chat',jsonb_build_array(msg),true);
    raise exception 'Wrong account accepted';
  exception when others then
    if sqlerrm <> 'Unknown webhook binding' then raise; end if;
  end;
  perform public.avito_mark_cached_read(a,'main','12345','chat',array['m1']);
  perform public.avito_cache_messages(a,'main','12345','chat',jsonb_build_array(msg || '{"type":"deleted","text":"Сообщение удалено"}'::jsonb),true);
  perform public.avito_cache_messages(a,'main','12345','chat',jsonb_build_array(msg),false);
  select message into stored from public.avito_messenger_messages where owner_id=a;
  if stored->>'type'<>'deleted' or stored->>'text'<>'Сообщение удалено' or stored->>'isRead'<>'true' then
    raise exception 'Late snapshot restored deleted content or unread state';
  end if;
end $$;
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', current_setting('avito_test.owner_a'), true);
select set_config('request.jwt.claims', json_build_object('sub',current_setting('avito_test.owner_a'),'role','authenticated')::text, true);
do $$
declare n integer;
begin
  select count(*) into n from public.avito_messenger_messages;
  if n<>1 then raise exception 'Owner RLS leaked or hid messages'; end if;
  select count(*) into n from public.avito_cached_chats('main');
  if n<>1 then raise exception 'Cached chats leaked another owner'; end if;
  begin
    update public.avito_messenger_messages set message='{}';
    raise exception 'Browser UPDATE allowed';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.avito_cache_messages(current_setting('avito_test.owner_a')::uuid,'main','12345','chat','[]',false);
    raise exception 'Browser service RPC allowed';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.avito_messenger_accounts;
    raise exception 'Browser account DELETE allowed';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- Rebinding a configured key must hide the previous Avito account's retained history.
select public.avito_cache_messages(current_setting('avito_test.owner_a')::uuid,'main','55555','chat','[]',false);
set local role authenticated;
do $$ begin
  if exists(select 1 from public.avito_messenger_messages) then raise exception 'Old account history remains visible after rebinding'; end if;
end $$;
reset role;
set local role anon;
do $$ begin
  begin
    perform 1 from public.avito_messenger_messages;
    raise exception 'Anonymous SELECT allowed';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
rollback;
