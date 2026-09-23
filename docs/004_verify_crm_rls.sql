-- 004: Check CRM grants, owner RLS and cross-owner foreign keys.
-- Run the WHOLE file in Supabase SQL Editor as postgres after 001-003.
-- Intended for a fresh project without custom auth.users INSERT triggers.
-- Random fixture users/rows exist only in this transaction and are rolled back.
-- This emulates database roles/JWT claims; it does not test real Auth or HTTP JWT validation.
-- If execution fails, run ROLLBACK before retrying in the same SQL session.

begin;

do $fixtures$
declare
  setting_name text;
begin
  foreach setting_name in array array[
    'owner_a', 'owner_b', 'products_a', 'products_b',
    'buyers_a', 'buyers_b', 'messages_a', 'messages_b'
  ] loop
    perform set_config('crm_rls.' || setting_name, gen_random_uuid()::text, true);
  end loop;
  insert into auth.users (id) values
    (current_setting('crm_rls.owner_a')::uuid),
    (current_setting('crm_rls.owner_b')::uuid);
end
$fixtures$;

set local role authenticated;

do $authenticated_checks$
declare
  suffix text;
  table_name text;
  owner_a uuid := current_setting('crm_rls.owner_a')::uuid;
  owner_b uuid := current_setting('crm_rls.owner_b')::uuid;
  acting_owner uuid;
  product_id uuid;
  buyer_id uuid;
  message_id uuid;
  fixture_id uuid;
  affected bigint;
  statement text;
  denial record;
begin
  -- Both owners can insert, read and update their own records in all three tables.
  foreach suffix in array array['a', 'b'] loop
    acting_owner := current_setting('crm_rls.owner_' || suffix)::uuid;
    perform set_config('request.jwt.claim.sub', acting_owner::text, true);
    perform set_config('request.jwt.claims',
      json_build_object('sub', acting_owner, 'role', 'authenticated')::text, true);
    if auth.uid() is distinct from acting_owner then
      raise exception 'Claim setup failed for owner %', suffix;
    end if;
    product_id := current_setting('crm_rls.products_' || suffix)::uuid;
    buyer_id := current_setting('crm_rls.buyers_' || suffix)::uuid;
    message_id := current_setting('crm_rls.messages_' || suffix)::uuid;

    -- Omit owner_id to also check its auth.uid() default.
    insert into public.products (id, title, price, category)
      values (product_id, 'RLS fixture', 100, 'Test');
    insert into public.buyers (id, name, product_id)
      values (buyer_id, 'RLS fixture', product_id);
    insert into public.messages (id, buyer_id, text, direction)
      values (message_id, buyer_id, 'RLS fixture', 'incoming');

    foreach table_name in array array['products', 'buyers', 'messages'] loop
      fixture_id := current_setting('crm_rls.' || table_name || '_' || suffix)::uuid;
      execute format('select count(*) from public.%I where id = $1 and owner_id = $2', table_name)
        into affected using fixture_id, acting_owner;
      if affected <> 1 then
        raise exception 'Owner % cannot read own inserted % row', suffix, table_name;
      end if;
      statement := case table_name
        when 'products' then 'update public.products set title = ''RLS updated'' where id = $1'
        when 'buyers' then 'update public.buyers set name = ''RLS updated'' where id = $1'
        else 'update public.messages set text = ''RLS updated'' where id = $1'
      end;
      execute statement using fixture_id;
      get diagnostics affected = row_count;
      if affected <> 1 then
        raise exception 'Owner % cannot update own % row', suffix, table_name;
      end if;
    end loop;
  end loop;

  -- Acting as B: A's rows must be invisible and immutable.
  foreach table_name in array array['products', 'buyers', 'messages'] loop
    fixture_id := current_setting('crm_rls.' || table_name || '_a')::uuid;
    execute format('select count(*) from public.%I where id = $1', table_name)
      into affected using fixture_id;
    if affected <> 0 then raise exception 'Cross-owner SELECT allowed on %', table_name; end if;
    execute format('update public.%I set owner_id = owner_id where id = $1', table_name)
      using fixture_id;
    get diagnostics affected = row_count;
    if affected <> 0 then raise exception 'Cross-owner UPDATE allowed on %', table_name; end if;
    execute format('delete from public.%I where id = $1', table_name) using fixture_id;
    get diagnostics affected = row_count;
    if affected <> 0 then raise exception 'Cross-owner DELETE allowed on %', table_name; end if;
  end loop;

  -- Inserts with a forged owner and reassignment of owned rows must fail RLS.
  for denial in
    select * from (values
      (format('insert into public.products (owner_id,title,price,category) values (%L,''forged'',1,''Test'')', owner_a), '42501'),
      (format('insert into public.buyers (owner_id,name) values (%L,''forged'')', owner_a), '42501'),
      (format('insert into public.messages (owner_id,buyer_id,text,direction) values (%L,%L,''forged'',''incoming'')', owner_a, current_setting('crm_rls.buyers_a')), '42501'),
      -- B owns these new rows, but cannot attach them to A's product/buyer.
      (format('insert into public.buyers (name,product_id) values (''cross-link'',%L)', current_setting('crm_rls.products_a')), '23503'),
      (format('insert into public.messages (buyer_id,text,direction) values (%L,''cross-link'',''incoming'')', current_setting('crm_rls.buyers_a')), '23503'),
      (format('update public.buyers set product_id = %L where id = %L', current_setting('crm_rls.products_a'), current_setting('crm_rls.buyers_b')), '23503'),
      (format('update public.messages set buyer_id = %L where id = %L', current_setting('crm_rls.buyers_a'), current_setting('crm_rls.messages_b')), '23503')
    ) as attempts(query, expected_state)
  loop
    begin
      execute denial.query;
      raise exception 'Expected SQLSTATE %, but statement succeeded: %', denial.expected_state, denial.query;
    exception when others then
      if sqlstate <> denial.expected_state then raise; end if;
    end;
  end loop;

  foreach table_name in array array['products', 'buyers', 'messages'] loop
    fixture_id := current_setting('crm_rls.' || table_name || '_b')::uuid;
    begin
      execute format('update public.%I set owner_id = $1 where id = $2', table_name)
        using owner_a, fixture_id;
      raise exception 'Owner reassignment allowed on %', table_name;
    exception when insufficient_privilege then null;
    end;
  end loop;

  -- Return to A. Prove denied changes left the original rows/values intact.
  perform set_config('request.jwt.claim.sub', owner_a::text, true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', owner_a, 'role', 'authenticated')::text, true);
  foreach table_name in array array['products', 'buyers', 'messages'] loop
    fixture_id := current_setting('crm_rls.' || table_name || '_a')::uuid;
    statement := format('select count(*) from public.%I where id = $1 and owner_id = $2 and %I = ''RLS updated''',
      table_name, case table_name when 'products' then 'title' when 'buyers' then 'name' else 'text' end);
    execute statement into affected using fixture_id, owner_a;
    if affected <> 1 then raise exception 'Owner A row changed or disappeared: %', table_name; end if;
  end loop;

  -- Own DELETE is allowed; delete dependents first to respect foreign keys.
  foreach table_name in array array['messages', 'buyers', 'products'] loop
    fixture_id := current_setting('crm_rls.' || table_name || '_a')::uuid;
    execute format('delete from public.%I where id = $1', table_name) using fixture_id;
    get diagnostics affected = row_count;
    if affected <> 1 then raise exception 'Owner DELETE failed on %', table_name; end if;
  end loop;
end
$authenticated_checks$;

set local role anon;

do $anonymous_checks$
declare
  table_name text;
  statement text;
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  if auth.uid() is not null then raise exception 'Anonymous claim setup failed'; end if;

  foreach table_name in array array['products', 'buyers', 'messages'] loop
    foreach statement in array array[
      format('select * from public.%I', table_name),
      format('insert into public.%I default values', table_name),
      format('update public.%I set owner_id = owner_id', table_name),
      format('delete from public.%I', table_name)
    ] loop
      begin
        execute statement;
        raise exception 'Anonymous operation was allowed: %', statement;
      exception when insufficient_privilege then null;
      end;
    end loop;
  end loop;
end
$anonymous_checks$;

reset role;
-- Admin deletion of an Auth user must cascade through all CRM relations.
do $cascade_check$
declare
  table_name text;
  affected bigint;
begin
  delete from auth.users where id = current_setting('crm_rls.owner_b')::uuid;
  foreach table_name in array array['products', 'buyers', 'messages'] loop
    execute format('select count(*) from public.%I where owner_id = $1', table_name)
      into affected using current_setting('crm_rls.owner_b')::uuid;
    if affected <> 0 then raise exception 'Auth owner cascade failed on %', table_name; end if;
  end loop;
end
$cascade_check$;
select 'PASS: owner CRUD, cross-owner isolation, composite foreign keys and anonymous denial' as result;
rollback;
-- Successful completion rolls back ALL fixtures. There are no permanent test users or rows.
