-- 009. Durable Avito messages, webhook account binding and owner-only Realtime.
-- Run the WHOLE file in Supabase SQL Editor. Does not alter CRM draft messages.
begin;

create table public.avito_messenger_accounts (
  owner_id uuid not null references auth.users(id) on delete cascade,
  account_key text not null check (account_key ~ '^[a-zA-Z0-9_-]{1,40}$'),
  avito_user_id text not null check (avito_user_id ~ '^[1-9][0-9]{0,18}$'),
  webhook_enabled boolean not null default false,
  registered_at timestamptz,
  last_event_at timestamptz,
  primary key (owner_id, account_key)
);
comment on table public.avito_messenger_accounts is 'Server-verified CRM owner/account binding. No tokens or callback URLs. webhook_enabled means registration confirmed, not delivery guaranteed.';

create table public.avito_messenger_messages (
  owner_id uuid not null references auth.users(id) on delete cascade,
  account_key text not null,
  avito_user_id text not null,
  chat_id text not null check (length(chat_id) between 1 and 200),
  message_id text not null check (length(message_id) between 1 and 200),
  created bigint not null check (created between 0 and 1000000000000),
  message jsonb not null check (jsonb_typeof(message) = 'object'),
  updated_at timestamptz not null default now(),
  primary key (owner_id, account_key, avito_user_id, chat_id, message_id),
  foreign key (owner_id, account_key) references public.avito_messenger_accounts(owner_id, account_key) on delete cascade
);
comment on table public.avito_messenger_messages is 'Normalized Avito messages only. Composite identity deduplicates webhook/API/send. Deleted content cannot be restored by delayed history; read state is monotonic. Only server functions write.';
create index avito_messenger_history_idx on public.avito_messenger_messages(owner_id, account_key, chat_id, created desc, message_id desc);

alter table public.avito_messenger_accounts enable row level security;
alter table public.avito_messenger_messages enable row level security;
revoke all on public.avito_messenger_accounts, public.avito_messenger_messages from public, anon, authenticated;
grant select on public.avito_messenger_accounts, public.avito_messenger_messages to authenticated;
grant all on public.avito_messenger_accounts, public.avito_messenger_messages to service_role;
create policy avito_messenger_accounts_select on public.avito_messenger_accounts for select to authenticated
  using (owner_id = (select auth.uid()));
create policy avito_messenger_messages_select on public.avito_messenger_messages for select to authenticated
  using (owner_id = (select auth.uid()) and exists (
    select 1 from public.avito_messenger_accounts a where a.owner_id = avito_messenger_messages.owner_id
      and a.account_key = avito_messenger_messages.account_key and a.avito_user_id = avito_messenger_messages.avito_user_id
  ));

create function public.avito_cache_messages(p_owner uuid, p_key text, p_account text, p_chat text, p_messages jsonb, p_webhook boolean default false)
returns void language plpgsql security invoker set search_path = '' as $$
declare
  msg jsonb;
  previous jsonb;
  merged jsonb;
begin
  if p_key !~ '^[a-zA-Z0-9_-]{1,40}$' or p_account !~ '^[1-9][0-9]{0,18}$'
    or length(p_chat) not between 1 and 200 or jsonb_typeof(p_messages) <> 'array' then
    raise exception 'Invalid messenger payload';
  end if;
  if jsonb_array_length(p_messages) > 50 then raise exception 'Too many messages'; end if;
  if p_webhook then
    -- Never create/rebind an owner from a webhook payload. Registration/API established it.
    perform 1 from public.avito_messenger_accounts where owner_id = p_owner and account_key = p_key and avito_user_id = p_account for update;
    if not found then raise exception 'Unknown webhook binding'; end if;
  else
    insert into public.avito_messenger_accounts(owner_id, account_key, avito_user_id)
      values (p_owner, p_key, p_account)
      on conflict (owner_id, account_key) do update set
        avito_user_id = excluded.avito_user_id,
        webhook_enabled = case when avito_messenger_accounts.avito_user_id = excluded.avito_user_id then avito_messenger_accounts.webhook_enabled else false end,
        registered_at = case when avito_messenger_accounts.avito_user_id = excluded.avito_user_id then avito_messenger_accounts.registered_at else null end,
        last_event_at = case when avito_messenger_accounts.avito_user_id = excluded.avito_user_id then avito_messenger_accounts.last_event_at else null end;
  end if;
  -- The account row lock serializes snapshots, read receipts and concurrent deliveries.
  for msg in select value from jsonb_array_elements(p_messages) loop
    if jsonb_typeof(msg) <> 'object' or jsonb_typeof(msg->'id') is distinct from 'string'
      or length(msg->>'id') not between 1 and 200 or jsonb_typeof(msg->'text') is distinct from 'string'
      or length(msg->>'text') > 20000 or jsonb_typeof(msg->'direction') is distinct from 'string' or msg->>'direction' not in ('in','out')
      or jsonb_typeof(msg->'isRead') is distinct from 'boolean' or jsonb_typeof(msg->'type') is distinct from 'string' or (msg->>'type') !~ '^[a-zA-Z_]{1,40}$'
      or jsonb_typeof(msg->'created') is distinct from 'number' or (msg->>'created') !~ '^[0-9]{1,13}$' then
      raise exception 'Invalid normalized message';
    end if;
    -- Discard extra fields; retain neither the raw payload nor any attachment credentials.
    msg := jsonb_build_object('id',msg->>'id','text',msg->>'text','type',msg->>'type','created',(msg->>'created')::bigint,'direction',msg->>'direction','isRead',(msg->>'isRead')::boolean);
    previous := null;
    select message into previous from public.avito_messenger_messages
      where owner_id = p_owner and account_key = p_key and avito_user_id = p_account and chat_id = p_chat and message_id = msg->>'id';
    merged := case when previous->>'type' = 'deleted' then previous else msg end;
    if previous is not null then merged := jsonb_set(merged, '{created}', previous->'created'); end if;
    merged := jsonb_set(merged, '{isRead}', to_jsonb(coalesce((previous->>'isRead')::boolean, false) or (msg->>'isRead')::boolean));
    insert into public.avito_messenger_messages(owner_id,account_key,avito_user_id,chat_id,message_id,created,message)
      values(p_owner,p_key,p_account,p_chat,msg->>'id',(merged->>'created')::bigint,merged)
      on conflict (owner_id,account_key,avito_user_id,chat_id,message_id) do update
        set message = excluded.message, updated_at = now()
        where avito_messenger_messages.message is distinct from excluded.message;
  end loop;
  if p_webhook then
    update public.avito_messenger_accounts set last_event_at = now() where owner_id = p_owner and account_key = p_key;
  end if;
end;
$$;
revoke all on function public.avito_cache_messages(uuid,text,text,text,jsonb,boolean) from public, anon, authenticated;
grant execute on function public.avito_cache_messages(uuid,text,text,text,jsonb,boolean) to service_role;

create function public.avito_mark_cached_read(p_owner uuid, p_key text, p_account text, p_chat text, p_ids text[])
returns void language plpgsql security invoker set search_path = '' as $$
begin
  if cardinality(p_ids) > 1000 then raise exception 'Too many receipts'; end if;
  perform 1 from public.avito_messenger_accounts where owner_id = p_owner and account_key = p_key and avito_user_id = p_account for update;
  if not found then return; end if;
  update public.avito_messenger_messages set message = jsonb_set(message,'{isRead}','true'), updated_at = now()
    where owner_id = p_owner and account_key = p_key and avito_user_id = p_account and chat_id = p_chat
      and message_id = any(p_ids) and message->>'direction' = 'in' and message->>'isRead' = 'false';
end;
$$;
revoke all on function public.avito_mark_cached_read(uuid,text,text,text,text[]) from public, anon, authenticated;
grant execute on function public.avito_mark_cached_read(uuid,text,text,text,text[]) to service_role;

create function public.avito_cached_chats(p_key text, p_offset integer default 0)
returns table(chat_id text, message jsonb) language sql stable security invoker set search_path = '' as $$
  select latest.chat_id, latest.message from (
    select distinct on (m.chat_id) m.chat_id, m.message, m.created, m.message_id
    from public.avito_messenger_messages m where m.account_key = p_key and m.owner_id = (select auth.uid())
    order by m.chat_id, m.created desc, m.message_id desc
  ) latest order by latest.created desc, latest.message_id desc limit 50 offset greatest(0,least(p_offset,1000));
$$;
revoke all on function public.avito_cached_chats(text,integer) from public, anon;
grant execute on function public.avito_cached_chats(text,integer) to authenticated;

-- Realtime uses the SELECT policy above, including the current Avito account binding.
do $$ begin
  if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='avito_messenger_messages') then
    alter publication supabase_realtime add table public.avito_messenger_messages;
  end if;
end $$;
commit;
