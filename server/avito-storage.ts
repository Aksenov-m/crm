import { inTransaction, pool } from "./db.js";
import type { PoolClient } from "pg";

type Binding = { ownerId: string; key: string; accountId: string };
type Input = Record<string, unknown>;
const UUID = /^[0-9a-f-]{36}$/i;
const ACCOUNT_KEY = /^[a-zA-Z0-9_-]{1,40}$/;
const AVITO_ID = /^[1-9][0-9]{0,18}$/;

function bodyOf(init: RequestInit): Input {
  if (typeof init.body !== "string") return {};
  try {
    const value: unknown = JSON.parse(init.body);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Input : {};
  } catch { return {}; }
}

function filter(query: URLSearchParams, name: string, operator = "eq"): string | null {
  const raw = query.get(name);
  const prefix = `${operator}.`;
  return raw?.startsWith(prefix) ? raw.slice(prefix.length) : null;
}

async function cacheMessages(client: PoolClient, input: Input): Promise<void> {
  const ownerId = String(input.p_owner || "");
  const accountKey = String(input.p_key || "");
  const accountId = String(input.p_account || "");
  const chatId = String(input.p_chat || "");
  const messages = input.p_messages;
  const webhook = input.p_webhook === true;
  if (!UUID.test(ownerId) || !ACCOUNT_KEY.test(accountKey) || !AVITO_ID.test(accountId) || !chatId || chatId.length > 200 || !Array.isArray(messages) || messages.length > 50) throw new Error("Invalid messenger cache request");

  if (webhook) {
    const account = await client.query("select 1 from avito_messenger_accounts where owner_id=$1 and account_key=$2 and avito_user_id=$3 for update", [ownerId, accountKey, accountId]);
    if (!account.rowCount) throw new Error("Unknown webhook binding");
  } else {
    await client.query(
      `insert into avito_messenger_accounts(owner_id,account_key,avito_user_id)
       values($1,$2,$3)
       on conflict(owner_id,account_key) do update set
         avito_user_id=excluded.avito_user_id,
         webhook_enabled=case when avito_messenger_accounts.avito_user_id=excluded.avito_user_id then avito_messenger_accounts.webhook_enabled else false end,
         registered_at=case when avito_messenger_accounts.avito_user_id=excluded.avito_user_id then avito_messenger_accounts.registered_at else null end,
         last_event_at=case when avito_messenger_accounts.avito_user_id=excluded.avito_user_id then avito_messenger_accounts.last_event_at else null end`,
      [ownerId, accountKey, accountId],
    );
    await client.query("select 1 from avito_messenger_accounts where owner_id=$1 and account_key=$2 for update", [ownerId, accountKey]);
  }

  for (const value of messages) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid normalized message");
    const message = value as Input;
    const id = typeof message.id === "string" ? message.id : "";
    const text = typeof message.text === "string" ? message.text : "";
    const type = typeof message.type === "string" ? message.type : "";
    const direction = typeof message.direction === "string" ? message.direction : "";
    const created = message.created;
    const isRead = message.isRead;
    if (!id || id.length > 200 || text.length > 20_000 || !/^[a-zA-Z_]{1,40}$/.test(type) || !["in", "out"].includes(direction) || !Number.isSafeInteger(created) || Number(created) < 0 || Number(created) > 1e12 || typeof isRead !== "boolean") throw new Error("Invalid normalized message");
    const previousResult = await client.query<{ message: Record<string, unknown> }>(
      `select message from avito_messenger_messages where owner_id=$1 and account_key=$2 and avito_user_id=$3 and chat_id=$4 and message_id=$5 for update`,
      [ownerId, accountKey, accountId, chatId, id],
    );
    const previous = previousResult.rows[0]?.message;
    const merged: Input = previous?.type === "deleted"
      ? { ...previous }
      : { id, text, type, created: previous?.created ?? created, direction, isRead: previous?.isRead === true || isRead };
    if (previous?.type === "deleted") merged.isRead = previous.isRead === true || isRead;
    await client.query(
      `insert into avito_messenger_messages(owner_id,account_key,avito_user_id,chat_id,message_id,created,message)
       values($1,$2,$3,$4,$5,$6,$7::jsonb)
       on conflict(owner_id,account_key,avito_user_id,chat_id,message_id) do update
         set message=excluded.message,updated_at=now()
         where avito_messenger_messages.message is distinct from excluded.message`,
      [ownerId, accountKey, accountId, chatId, id, merged.created, JSON.stringify(merged)],
    );
  }
  if (webhook) await client.query("update avito_messenger_accounts set last_event_at=now() where owner_id=$1 and account_key=$2", [ownerId, accountKey]);
}

export async function cacheAvitoMessages(binding: Binding, chatId: string, messages: unknown[], webhook = false): Promise<void> {
  await inTransaction((client) => cacheMessages(client, {
    p_owner: binding.ownerId, p_key: binding.key, p_account: binding.accountId,
    p_chat: chatId, p_messages: messages, p_webhook: webhook,
  }));
}

async function storageRpc(path: string, input: Input): Promise<unknown> {
  if (path === "rpc/avito_cache_messages") {
    await inTransaction((client) => cacheMessages(client, input));
    return null;
  }
  if (path === "rpc/avito_consume_oauth_state") {
    const { rows } = await pool.query(
      `delete from avito_oauth_states where owner_id=$1 and state_hash=$2 and expires_at>now() returning account_key,redirect_uri`,
      [input.p_owner, input.p_state_hash],
    );
    return rows;
  }
  if (path === "rpc/avito_mark_cached_read") {
    const ownerId = String(input.p_owner || "");
    const accountKey = String(input.p_key || "");
    const accountId = String(input.p_account || "");
    const chatId = String(input.p_chat || "");
    const ids = Array.isArray(input.p_ids) ? input.p_ids.filter((id): id is string => typeof id === "string").slice(0, 1000) : [];
    if (!UUID.test(ownerId) || !ACCOUNT_KEY.test(accountKey) || !AVITO_ID.test(accountId) || !chatId || !ids.length) return null;
    await inTransaction(async (client) => {
      await client.query("select 1 from avito_messenger_accounts where owner_id=$1 and account_key=$2 and avito_user_id=$3 for update", [ownerId, accountKey, accountId]);
      await client.query(
        `update avito_messenger_messages set message=jsonb_set(message,'{isRead}','true'),updated_at=now()
          where owner_id=$1 and account_key=$2 and avito_user_id=$3 and chat_id=$4 and message_id=any($5::text[])
            and message->>'direction'='in' and message->>'isRead'='false'`,
        [ownerId, accountKey, accountId, chatId, ids],
      );
    });
    return null;
  }
  throw new Error("Unsupported backend database operation");
}

export async function avitoStorage(path: string, init: RequestInit = {}): Promise<unknown> {
  const [resource, rawQuery = ""] = path.split("?", 2);
  const query = new URLSearchParams(rawQuery);
  const method = (init.method || "GET").toUpperCase();
  const input = bodyOf(init);
  if (resource.startsWith("rpc/")) return storageRpc(resource, input);

  if (resource === "avito_oauth_tokens") {
    if (method === "GET") {
      const ownerId = filter(query, "owner_id");
      const key = filter(query, "account_key");
      const { rows } = await pool.query("select access_token,refresh_token,expires_at,token_type from avito_oauth_tokens where owner_id=$1 and account_key=$2", [ownerId, key]);
      return rows;
    }
    if (method === "POST") {
      await pool.query(
        `insert into avito_oauth_tokens(owner_id,account_key,access_token,refresh_token,token_type,expires_at,scope)
         values($1,$2,$3,$4,$5,$6,$7)
         on conflict(owner_id,account_key) do update set access_token=excluded.access_token,refresh_token=excluded.refresh_token,
           token_type=excluded.token_type,expires_at=excluded.expires_at,scope=excluded.scope,updated_at=now()`,
        [input.owner_id,input.account_key,input.access_token,input.refresh_token,input.token_type,input.expires_at,input.scope ?? null],
      );
      return null;
    }
  }

  if (resource === "avito_oauth_states") {
    if (method === "DELETE") {
      const expiry = filter(query, "expires_at", "lt");
      if (expiry) await pool.query("delete from avito_oauth_states where expires_at < $1", [expiry]);
      return null;
    }
    if (method === "POST") {
      await pool.query("insert into avito_oauth_states(owner_id,account_key,state_hash,redirect_uri,expires_at) values($1,$2,$3,$4,$5)", [input.owner_id,input.account_key,input.state_hash,input.redirect_uri,input.expires_at]);
      return null;
    }
  }

  if (resource === "products" && method === "GET") {
    const ownerId = filter(query, "owner_id");
    const id = filter(query, "id");
    if (!ownerId || !id) return [];
    const { rows } = await pool.query("select id,title,description,price,image_path,category,stage from products where owner_id=$1 and id=$2", [ownerId,id]);
    return rows;
  }

  if (resource === "avito_publications") {
    if (method === "POST") {
      await pool.query(
        `insert into avito_publications(owner_id,account_key,product_id,status,address,manager_name,contact_phone,report_email,last_error)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9)
         on conflict(owner_id,account_key,product_id) do update set status=excluded.status,address=excluded.address,
           manager_name=excluded.manager_name,contact_phone=excluded.contact_phone,report_email=excluded.report_email,last_error=excluded.last_error,updated_at=now()`,
        [input.owner_id,input.account_key,input.product_id,input.status,input.address,input.manager_name,input.contact_phone,input.report_email ?? null,input.last_error ?? null],
      );
      return null;
    }
    if (method === "PATCH") {
      const ownerId = filter(query, "owner_id");
      const accountKey = filter(query, "account_key");
      const productId = filter(query, "product_id");
      await pool.query("update avito_publications set status=$4,last_error=$5,updated_at=now() where owner_id=$1 and account_key=$2 and product_id=$3", [ownerId,accountKey,productId,input.status,input.last_error]);
      return null;
    }
  }

  if (resource === "avito_messenger_accounts") {
    const ownerId = filter(query, "owner_id");
    const accountKey = filter(query, "account_key");
    const accountId = filter(query, "avito_user_id");
    if (method === "GET") {
      if (ownerId && !accountKey && !accountId) {
        const { rows } = await pool.query("select account_key,avito_user_id from avito_messenger_accounts where owner_id=$1", [ownerId]);
        return rows;
      }
      const { rows } = await pool.query("select webhook_enabled,last_event_at from avito_messenger_accounts where owner_id=$1 and account_key=$2 and avito_user_id=$3", [ownerId,accountKey,accountId]);
      return rows;
    }
    if (method === "PATCH") {
      await pool.query("update avito_messenger_accounts set webhook_enabled=$4,registered_at=$5 where owner_id=$1 and account_key=$2 and avito_user_id=$3", [ownerId,accountKey,accountId,input.webhook_enabled,input.registered_at]);
      return null;
    }
  }

  throw new Error("Unsupported backend database operation");
}

export async function avitoCachedMessages(ownerId: string, accountKey: string, chatId: string, offset: number) {
  const { rows } = await pool.query(
    `select message from avito_messenger_messages where owner_id=$1 and account_key=$2 and chat_id=$3
      order by created desc,message_id desc offset $4 limit 50`,
    [ownerId,accountKey,chatId,offset],
  );
  return rows.map((row) => row.message).reverse();
}

export async function avitoCachedChats(ownerId: string, accountKey: string, offset: number) {
  const { rows } = await pool.query(
    `select latest.chat_id,latest.message from (
       select distinct on (m.chat_id) m.chat_id,m.message,m.created,m.message_id
       from avito_messenger_messages m where m.owner_id=$1 and m.account_key=$2
       order by m.chat_id,m.created desc,m.message_id desc
     ) latest order by latest.created desc,latest.message_id desc offset $3 limit 50`,
    [ownerId,accountKey,Math.max(0,Math.min(offset,1000))],
  );
  return rows;
}

export async function connectAvitoItem(ownerId: string, accountId: string, item: Input, productId: string | null): Promise<string> {
  if (!UUID.test(ownerId) || !AVITO_ID.test(accountId) || !/^[1-9][0-9]{0,18}$/.test(String(item.id || ""))) throw new Error("Invalid listing identifiers");
  return inTransaction(async (client) => {
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`${ownerId}:${accountId}:${item.id}`]);
    const existing = await client.query<{ product_id: string }>("select product_id from avito_item_links where owner_id=$1 and account_id=$2 and item_id=$3", [ownerId,accountId,item.id]);
    if (existing.rows[0]) {
      if (productId && existing.rows[0].product_id !== productId) throw new Error("Listing already linked to another product");
      return existing.rows[0].product_id;
    }
    let linkedProductId = productId;
    if (linkedProductId) {
      const found = await client.query("select 1 from products where owner_id=$1 and id=$2", [ownerId,linkedProductId]);
      if (!found.rowCount) throw new Error("Product not available");
    } else {
      const price = Number(item.price ?? 0);
      const category = typeof item.category === "string" && item.category.trim() ? item.category.trim().slice(0,1000) : "Другое";
      const stage = item.status === "active" ? "published" : "new";
      const result = await client.query<{ id: string }>(
        "insert into products(owner_id,title,description,price,category,stage) values($1,$2,'',$3,$4,$5) returning id",
        [ownerId,String(item.title || "").trim().slice(0,1000) || "Без названия",Number.isFinite(price) && price >= 0 && price < 1e12 ? price : 0,category,stage],
      );
      linkedProductId = result.rows[0]?.id || null;
    }
    if (!linkedProductId) throw new Error("Product creation failed");
    await client.query(
      `insert into avito_item_links(owner_id,account_id,item_id,product_id,avito_title,avito_status,avito_url)
       values($1,$2,$3,$4,$5,$6,$7)`,
      [ownerId,accountId,item.id,linkedProductId,String(item.title || "Без названия").trim().slice(0,1000),String(item.status || "unknown").slice(0,100),item.url ?? null],
    );
    return linkedProductId;
  });
}
