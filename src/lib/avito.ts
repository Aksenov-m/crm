import type { SupabaseClient } from "@supabase/supabase-js";
import { getCrmErrorMessage, PRODUCT_IMAGES_BUCKET } from "./crm-repository";

export type AvitoAccount = { key: string; name: string };
export type AvitoProfile = { id: string; name: string; profileUrl: string | null };
export type AvitoItem = { id: string; title: string; description: string; price: number | null; category: string; status: string; url: string | null; imageUrl: string | null };
export type AvitoItemsPage = { items: AvitoItem[]; page: number; hasMore: boolean; fetchedAt: string };
export type AvitoLink = { account_id: string; item_id: string; product_id: string };

export function createAvitoRepository(client: SupabaseClient) {
  async function invoke<T>(body: Record<string, unknown>): Promise<T> {
    const { data, error } = await client.functions.invoke("avito", { body });
    if (error) {
      if (error.context instanceof Response) {
        let publicMessage = "";
        try {
          const response = await error.context.json();
          if (typeof response?.message === "string" && response.message.length < 500 && typeof response?.error === "string") publicMessage = response.message;
        } catch { /* Non-JSON gateway errors use the safe fallback below. */ }
        if (publicMessage) throw new Error(publicMessage);
      }
      throw new Error("Не удалось вызвать подключение Авито. Проверьте публикацию функции avito, её настройки и вход в CRM.");
    }
    return data as T;
  }
  return {
    async accounts() { return (await invoke<{ accounts: AvitoAccount[] }>({ action: "accounts" })).accounts; },
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
