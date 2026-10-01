import type { SupabaseClient } from "@supabase/supabase-js";
import { getCrmErrorMessage, PRODUCT_IMAGES_BUCKET } from "./crm-repository";

export type AvitoAccount = { key: string; name: string };
export type AvitoMessage = { id: string; text: string; type: string; created: number; direction: "in" | "out"; isRead: boolean };
export type AvitoChat = { id: string; name: string; itemTitle: string; itemUrl: string | null; lastMessage: AvitoMessage | null };
export type AvitoChatsPage = { chats: AvitoChat[]; offset: number; hasMore: boolean; warning?: string };
export type AvitoMessagesPage = { messages: AvitoMessage[]; offset: number; hasMore: boolean; warning?: string };
export type AvitoMessageEvent = { chatId: string; message: AvitoMessage };
export type AvitoWebhookStatus = { enabled: boolean; accountId: string; lastEventAt: string | null };
export type AvitoOAuthStart = { authorizeUrl: string; redirectUri: string };
export type AvitoOAuthResult = { connected: boolean; accountKey: string; returnOrigin: string };
export type AvitoRealtimeState = "connecting" | "connected" | "disconnected";
export type AvitoProfile = { id: string; name: string; profileUrl: string | null };
export type AvitoItem = { id: string; title: string; description: string; price: number | null; category: string; status: string; url: string | null; imageUrl: string | null };
export type AvitoItemsPage = { items: AvitoItem[]; page: number; hasMore: boolean; fetchedAt: string };
export type AvitoLink = { account_id: string; item_id: string; product_id: string };

export class AvitoRequestError extends Error {
  constructor(message: string, public status: number | null, public code: string) {
    super(message);
    this.name = "AvitoRequestError";
  }
}

export function mergeAvitoMessages(...groups: AvitoMessage[][]): AvitoMessage[] {
  const result = new Map<string, AvitoMessage>();
  for (const message of groups.flat()) {
    const previous = result.get(message.id);
    result.set(message.id, { ...(previous?.type === "deleted" ? previous : message), isRead: previous?.isRead === true || message.isRead });
  }
  return [...result.values()].sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));
}

function cachedMessage(value: unknown): AvitoMessage | null {
  if (!value || typeof value !== "object") return null;
  const row = value as AvitoMessage;
  return typeof row.id === "string" && typeof row.text === "string" && typeof row.type === "string" && Number.isSafeInteger(row.created) && ["in", "out"].includes(row.direction) && typeof row.isRead === "boolean" ? row : null;
}

export function createAvitoRepository(client: SupabaseClient) {
  async function invoke<T>(body: Record<string, unknown>): Promise<T> {
    const { data, error } = await client.functions.invoke("avito", { body });
    if (error) {
      if (error.context instanceof Response) {
        let publicMessage = "";
        let code = "function_error";
        try {
          const response = await error.context.clone().json();
          if (typeof response?.message === "string" && response.message.length < 500 && typeof response?.error === "string") {
            publicMessage = response.message;
            if (/^[a-z_]{1,60}$/.test(response.error)) code = response.error;
          }
        } catch { /* Non-JSON gateway errors use the safe fallback below. */ }
        if (publicMessage) throw new AvitoRequestError(publicMessage, error.context.status, code);
        throw new AvitoRequestError("Серверная функция avito не выполнила запрос. Проверьте её публикацию и вход в CRM.", error.context.status, code);
      }
      throw new AvitoRequestError("Не удалось вызвать подключение Авито. Проверьте публикацию функции avito, её настройки и вход в CRM.", null, "connection_error");
    }
    return data as T;
  }
  return {
    async accounts() { return (await invoke<{ accounts: AvitoAccount[] }>({ action: "accounts" })).accounts; },
    authorize(accountKey: string) { return invoke<AvitoOAuthStart>({ action: "oauth_start", accountKey }); },
    completeOAuth(code: string, state: string, providerError = "") { return invoke<AvitoOAuthResult>({ action: "oauth_callback", code, state, ...(providerError ? { error: providerError } : {}) }); },
    webhookStatus(accountKey: string) { return invoke<AvitoWebhookStatus>({ action: "webhook_status", accountKey }); },
    enableWebhook(accountKey: string) { return invoke<AvitoWebhookStatus>({ action: "enable_webhook", accountKey }); },
    async chats(accountKey: string, offset = 0): Promise<AvitoChatsPage> {
      try { return await invoke<AvitoChatsPage>({ action: "chats", accountKey, offset }); }
      catch (cause) {
        if (cause instanceof AvitoRequestError && ["avito_auth", "avito_subscription", "avito_access"].includes(cause.code)) throw cause;
        const { data, error } = await client.rpc("avito_cached_chats", { p_key: accountKey, p_offset: offset });
        if (error || !Array.isArray(data) || !data.length) throw cause;
        const chats = data.map((row) => ({ id: String(row.chat_id), name: "Собеседник Авито", itemTitle: "", itemUrl: null, lastMessage: cachedMessage(row.message) }));
        return { chats, offset, hasMore: chats.length === 50 && offset < 1000, warning: "Показаны сохранённые в CRM диалоги. " + (cause instanceof Error ? cause.message : "Авито временно недоступно.") };
      }
    },
    async messages(accountKey: string, chatId: string, offset = 0): Promise<AvitoMessagesPage> {
      try { return await invoke<AvitoMessagesPage>({ action: "chat_messages", accountKey, chatId, offset }); }
      catch (cause) {
        const { data, error } = await client.from("avito_messenger_messages").select("message").eq("account_key", accountKey).eq("chat_id", chatId).order("created", { ascending: false }).order("message_id", { ascending: false }).range(offset, offset + 49);
        const messages = (data ?? []).map((row) => cachedMessage(row.message)).filter((message): message is AvitoMessage => !!message);
        if (error || !messages.length) throw cause;
        return { messages, offset, hasMore: messages.length === 50 && offset < 1000, warning: "Показана сохранённая переписка; история может быть неполной. " + (cause instanceof Error ? cause.message : "Авито временно недоступно.") };
      }
    },
    watchMessages(accountKey: string, onMessage: (event: AvitoMessageEvent) => void, onState: (state: AvitoRealtimeState) => void) {
      let active = true;
      const deliver = (row: Record<string, unknown>) => {
        const message = cachedMessage(row.message);
        if (active && row.account_key === accountKey && typeof row.chat_id === "string" && message) onMessage({ chatId: row.chat_id, message });
      };
      onState("connecting");
      const channel = client.channel(`avito-messages-${crypto.randomUUID()}`)
        .on("postgres_changes", { event: "*", schema: "public", table: "avito_messenger_messages", filter: `account_key=eq.${accountKey}` }, (payload) => deliver(payload.new))
        .subscribe((status) => {
          if (!active) return;
          onState(status === "SUBSCRIBED" ? "connected" : "disconnected");
          if (status === "SUBSCRIBED") {
            // Subscribe before taking a snapshot so messages cannot fall into a join gap.
            void (async () => {
              const { data, error } = await client.from("avito_messenger_messages").select("account_key,chat_id,message").eq("account_key", accountKey).order("created", { ascending: false }).order("message_id", { ascending: false }).limit(200);
              if (!active) return;
              if (error) { onState("disconnected"); return; }
              for (const row of [...(data ?? [])].reverse()) deliver(row);
            })().catch(() => { if (active) onState("disconnected"); });
          }
        });
      return () => { active = false; void client.removeChannel(channel); };
    },
    async sendMessage(accountKey: string, chatId: string, text: string) { return (await invoke<{ message: AvitoMessage }>({ action: "send_message", accountKey, chatId, text })).message; },
    async readChat(accountKey: string, chatId: string, messageIds: string[] = []) {
      try {
        const result = await invoke<{ read?: boolean } | null>({ action: "read_chat", accountKey, chatId, ...(messageIds.length ? { messageIds: messageIds.slice(-100) } : {}) });
        if (result?.read !== true) throw new AvitoRequestError("Функция avito не подтвердила отметку прочтения. Опубликуйте актуальную версию функции.", null, "invalid_read_receipt");
      } catch (cause) {
        if (cause instanceof AvitoRequestError && cause.code === "invalid_action") {
          throw new AvitoRequestError("Опубликованная функция avito не поддерживает отметку прочтения. Обновите её из artifacts/avito-function/index.ts.", cause.status, cause.code);
        }
        throw cause;
      }
    },
    async profile(accountKey: string) { return (await invoke<{ profile: AvitoProfile }>({ action: "profile", accountKey })).profile; },
    items(accountKey: string, page: number) { return invoke<AvitoItemsPage>({ action: "items", accountKey, page }); },
    async downloadImage(accountKey: string, imageUrl: string): Promise<Blob> {
      const { data, error, response } = await client.functions.invoke("avito", { body: { action: "image", accountKey, imageUrl } });
      if (error) {
        if (error.context instanceof Response) {
          let publicMessage = "";
          try {
            const response = await error.context.json();
            if (typeof response?.message === "string" && response.message.length < 500 && typeof response?.error === "string") publicMessage = response.message;
          } catch { /* Non-JSON gateway errors use the safe fallback below. */ }
          if (publicMessage) throw new Error(publicMessage);
        }
        throw new Error("Не удалось загрузить фотографию объявления Авито. Повторите обновление позже.");
      }
      const contentType = response?.headers.get("x-image-content-type") || (data instanceof Blob ? data.type : "");
      if (!(data instanceof Blob) || data.size > 5 * 1024 * 1024 || !["image/jpeg", "image/png", "image/webp"].includes(contentType)) throw new Error("Авито вернуло неподдерживаемую фотографию объявления.");
      return data.type === contentType ? data : new Blob([data], { type: contentType });
    },
    async attachImage(ownerId: string, productId: string, image: Blob): Promise<void> {
      const type = image.type.toLowerCase();
      const extension = type === "image/png" ? "png" : type === "image/webp" ? "webp" : type === "image/jpeg" ? "jpg" : "";
      if (!extension || image.size === 0 || image.size > 5 * 1024 * 1024) throw new Error("Фотография объявления слишком большая или имеет неподдерживаемый формат.");
      const path = `${ownerId}/${productId}/${crypto.randomUUID()}.${extension}`;
      const { error: uploadError } = await client.storage.from(PRODUCT_IMAGES_BUCKET).upload(path, image, { contentType: type, upsert: false });
      if (uploadError) throw new Error("Не удалось сохранить фотографию объявления в CRM. Проверьте SQL-файл 005 и хранилище Supabase.");
      const { error: updateError } = await client.from("products").update({ image_path: path }).eq("owner_id", ownerId).eq("id", productId).select("id").single();
      if (updateError) throw new Error("Фотография загружена, но не удалось привязать её к товару CRM. Повторите обновление объявлений.");
    },
    async updateImportedDescription(ownerId: string, productId: string, description: string): Promise<void> {
      const value = description.trim().slice(0, 20000);
      if (!value) return;
      const { error } = await client.from("products").update({ description: value }).eq("owner_id", ownerId).eq("id", productId).select("id").single();
      if (error) throw new Error("Не удалось сохранить описание объявления в карточке CRM. Повторите обновление объявлений.");
    },
    async updatePriceForProduct(ownerId: string, productId: string, price: number): Promise<boolean> {
      const { data, error } = await client.from("avito_item_links").select("account_id,item_id").eq("owner_id", ownerId).eq("product_id", productId).limit(20);
      if (error) throw new Error("Не удалось найти связь товара с Авито. Проверьте выполнение SQL-файла 007 и соединение с базой.");
      const links = (data ?? []) as Array<{ account_id: string; item_id: string }>;
      for (const link of links) await invoke({ action: "update_price", accountId: link.account_id, itemId: link.item_id, price });
      return links.length > 0;
    },
    async links(ownerId: string, accountId: string): Promise<AvitoLink[]> {
      const rows: AvitoLink[] = [];
      let after = "";
      for (;;) {
        let query = client.from("avito_item_links").select("item_id,account_id,product_id").eq("owner_id", ownerId).eq("account_id", accountId).order("item_id").limit(500);
        if (after) query = query.gt("item_id", after);
        const { data, error } = await query;
        if (error) throw new Error("Не удалось загрузить связи с товарами. Проверьте выполнение SQL-файла 007 и соединение с базой.");
        if (!data?.length) return rows;
        rows.push(...data);
        const next = data[data.length - 1].item_id;
        if (next === after) throw new Error("Не удалось загрузить связи с товарами полностью.");
        after = next;
      }
    },
    async connectItem(accountId: string, item: AvitoItem, productId: string | null): Promise<string> {
      const { data, error } = await client.rpc("connect_avito_item", {
        p_account_id: accountId, p_item_id: item.id, p_title: item.title,
        p_price: item.price ?? 0, p_category: item.category || "Другое", p_status: item.status,
        p_url: item.url, p_product_id: productId,
      });
      if (error) throw new Error(getCrmErrorMessage(error));
      if (typeof data !== "string") throw new Error("Не удалось подтвердить привязку. Обновите данные перед повтором.");
      return data;
    },
  };
}
