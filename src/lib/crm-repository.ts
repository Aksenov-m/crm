import type { SupabaseClient } from "@supabase/supabase-js";
import { BUYER_STATUSES, STAGES, type Buyer, type BuyerStatus, type DemoState, type Message, type Product, type ProductStage } from "./crm";

export const PRODUCT_IMAGES_BUCKET = "product-images";
export const PRODUCT_IMAGE_PLACEHOLDER = "/products/placeholder.svg";
const SIGNED_URL_SECONDS = 60 * 60;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const PAGE_SIZE = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUILTIN_IMAGE = /^\/products\/(?:chair|camera|headphones|lamp|bike|coffee|speaker|console)\.jpg$/;

export interface ProductRow {
  id: string; owner_id: string; title: string; description: string; price: number | string;
  image_path: string | null; stage: Product["stage"]; category: string; views: number;
  favorites: number; created_at: string; sold_at: string | null;
}
export interface BuyerRow {
  id: string; owner_id: string; name: string; phone: string; product_id: string | null;
  status: Buyer["status"]; note: string;
}
export interface MessageRow {
  id: string; owner_id: string; buyer_id: string; text: string;
  direction: Message["direction"]; created_at: string; read: boolean;
}

export interface CrmRepository {
  load(): Promise<DemoState>;
  saveProduct(product: Product, existing: boolean): Promise<Product>;
  changeProductStage(id: string, stage: ProductStage, soldAt?: string): Promise<Product>;
  saveBuyer(buyer: Buyer, existing: boolean): Promise<Buyer>;
  updateBuyerStatus(id: string, status: BuyerStatus): Promise<Buyer>;
  addMessage(message: Message): Promise<Message>;
  markBuyerMessagesRead(buyerId: string): Promise<void>;
}

class CrmError extends Error {}

export function getCrmErrorMessage(error: unknown): string {
  if (error instanceof CrmError) return error.message;
  const source = typeof error === "object" && error !== null ? error as Record<string, unknown> : {};
  const code = String(source.code ?? "");
  const status = Number(source.status ?? source.statusCode);
  if (code === "23503") return "Связанный товар или покупатель больше недоступен. Обновите данные и повторите действие.";
  if (code === "23505") return "Такая запись уже существует. Обновите данные, прежде чем повторять сохранение.";
  if (code === "23514" || code === "22P02") return "Проверьте заполненные поля: база отклонила некорректные данные.";
  if (code === "42501" || status === 403) return "Нет доступа к данным. Проверьте вход и правила доступа Supabase.";
  if (status === 401 || code === "PGRST301" || code === "PGRST303") return "Сеанс истёк. Войдите в CRM снова.";
  if (code === "42P01" || code === "PGRST205") return "Таблицы CRM не найдены. Выполните SQL-файлы настройки Supabase.";
  if (code === "PGRST116") return "Запись больше недоступна. Обновите данные и повторите действие.";
  if (status === 413) return "Фотография слишком большая. Выберите файл до 5 МБ.";
  return "Не удалось выполнить запрос к Supabase. Проверьте соединение и обновите данные перед повтором.";
}

function fail(message: string): never { throw new CrmError(message); }
function assertUuid(value: string): void {
  if (typeof value !== "string" || !UUID.test(value)) fail("Некорректный идентификатор записи. Обновите данные.");
}
function timestamp(value: string): string {
  const parsed = new Date(value);
  if (typeof value !== "string" || !Number.isFinite(parsed.getTime())) fail("Некорректная дата записи.");
  return parsed.toISOString();
}
function isBuiltinImage(path: string): boolean {
  return BUILTIN_IMAGE.test(path) || path === PRODUCT_IMAGE_PLACEHOLDER;
}
function assertImagePath(path: string, ownerId: string, productId: string): void {
  if (isBuiltinImage(path)) return;
  const parts = path.split("/");
  if (parts.length !== 3 || parts[0] !== ownerId || parts[1] !== productId || !UUID.test(parts[2].replace(/\.jpg$/, "")) || !parts[2].endsWith(".jpg")) {
    fail("Некорректный путь фотографии. Выберите фотографию заново.");
  }
}
function assertProduct(product: Product): void {
  assertUuid(product.id);
  if (!product.title.trim() || !product.category.trim()) fail("Заполните название и категорию товара.");
  if (!Number.isFinite(product.price) || product.price < 0 || product.price >= 1e12) fail("Укажите корректную цену товара.");
  if (!STAGES.some(({ id }) => id === product.stage)) fail("Выберите корректный этап товара.");
  for (const value of [product.views, product.favorites]) {
    if (!Number.isInteger(value) || value < 0 || value > 2147483647) fail("Некорректная статистика товара.");
  }
  timestamp(product.createdAt);
  if (product.stage === "sold") {
    if (!product.soldAt) fail("Для проданного товара нужна дата продажи.");
    timestamp(product.soldAt);
  }
}

export function mapProductRow(row: ProductRow, image = PRODUCT_IMAGE_PLACEHOLDER): Product {
  assertUuid(row.id);
  assertUuid(row.owner_id);
  if (row.image_path) assertImagePath(row.image_path, row.owner_id, row.id);
  const product: Product = {
    id: row.id, title: row.title, description: row.description, price: Number(row.price),
    image: row.image_path && isBuiltinImage(row.image_path) ? row.image_path : image,
    ...(row.image_path ? { imagePath: row.image_path } : {}), stage: row.stage,
    category: row.category, views: row.views, favorites: row.favorites, createdAt: timestamp(row.created_at),
    ...(row.sold_at ? { soldAt: timestamp(row.sold_at) } : {}),
  };
  assertProduct(product);
  if ((row.stage === "sold") !== Boolean(row.sold_at)) fail("Дата продажи не соответствует этапу товара.");
  return product;
}

export function mapBuyerRow(row: BuyerRow): Buyer {
  assertUuid(row.id);
  if (row.product_id) assertUuid(row.product_id);
  if (!row.name.trim() || !BUYER_STATUSES.some(({ id }) => id === row.status)) fail("Некорректные данные покупателя.");
  return { id: row.id, name: row.name, phone: row.phone, productId: row.product_id ?? "", status: row.status, note: row.note };
}

export function mapMessageRow(row: MessageRow): Message {
  assertUuid(row.id);
  assertUuid(row.buyer_id);
  if (!row.text.trim() || !["incoming", "outgoing"].includes(row.direction) || typeof row.read !== "boolean") fail("Некорректные данные сообщения.");
  return { id: row.id, buyerId: row.buyer_id, text: row.text, direction: row.direction, createdAt: timestamp(row.created_at), read: row.read };
}

function jpegBlob(dataUrl: string): Blob {
  const prefix = "data:image/jpeg;base64,";
  if (!dataUrl.startsWith(prefix)) fail("Выберите фотографию JPEG, PNG или WebP заново.");
  const encoded = dataUrl.slice(prefix.length);
  if (!encoded || encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) fail("Некорректная или слишком большая фотография.");
  let decoded: string;
  try { decoded = atob(encoded); } catch { return fail("Не удалось прочитать фотографию. Выберите файл заново."); }
  const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  if (bytes.length > MAX_IMAGE_BYTES || bytes.length < 5 || bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255 || bytes[bytes.length - 2] !== 255 || bytes[bytes.length - 1] !== 217) fail("Не удалось прочитать JPEG-фотографию. Выберите файл заново.");
  return new Blob([bytes], { type: "image/jpeg" });
}

export function createCrmRepository(client: SupabaseClient, ownerId: string): CrmRepository {
  assertUuid(ownerId);
  const storage = () => client.storage.from(PRODUCT_IMAGES_BUCKET);

  async function allRows<T extends { id: string }>(table: "products" | "buyers" | "messages"): Promise<T[]> {
    const rows: T[] = [];
    let lastId: string | undefined;
    // Keyset pagination also works if a project's API row limit is below PAGE_SIZE.
    for (;;) {
      let query = client.from(table).select("*").eq("owner_id", ownerId).order("id", { ascending: true }).limit(PAGE_SIZE);
      if (lastId) query = query.gt("id", lastId);
      const { data, error } = await query;
      if (error) throw error;
      if (!data?.length) return rows;
      const page = data as T[];
      const nextId = page[page.length - 1].id;
      if (nextId === lastId) fail("Не удалось загрузить все записи. Обновите страницу.");
      rows.push(...page);
      lastId = nextId;
    }
  }

  async function signedImage(path: string): Promise<string> {
    const { data, error } = await storage().createSignedUrl(path, SIGNED_URL_SECONDS);
    if (error) throw error;
    if (!data?.signedUrl) fail("Не удалось открыть фотографию в Supabase Storage.");
    return data.signedUrl;
  }

  async function removeNewUpload(path: string): Promise<void> {
    // Only this operation's new object is eligible. Never remove an earlier photo.
    try { await storage().remove([path]); } catch { /* An orphan is safer than a broken saved photo. */ }
  }

  async function productWithImage(row: ProductRow): Promise<Product> {
    const product = mapProductRow(row);
    if (row.image_path && !isBuiltinImage(row.image_path)) {
      try { product.image = await signedImage(row.image_path); } catch { /* Retain its durable path when Storage is temporarily unavailable. */ }
    }
    return product;
  }

  return {
    async load() {
      const [productRows, buyerRows, messageRows] = await Promise.all([
        allRows<ProductRow>("products"), allRows<BuyerRow>("buyers"), allRows<MessageRow>("messages"),
      ]);
      const products: Product[] = [];
      // Bound signing concurrency rather than starting a request for every photo at once.
      for (let offset = 0; offset < productRows.length; offset += 10) {
        const batch = await Promise.all(productRows.slice(offset, offset + 10).map(productWithImage));
        products.push(...batch);
      }
      return {
        version: 1, products: products.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
        buyers: buyerRows.map(mapBuyerRow),
        messages: messageRows.map(mapMessageRow).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
      };
    },

    async saveProduct(product, existing) {
      assertProduct(product);
      let imagePath: string | null = null;
      let image = product.image || PRODUCT_IMAGE_PLACEHOLDER;
      let uploadedPath: string | undefined;
      let databaseAttempted = false;
      try {
        if (product.image.startsWith("data:")) {
          const file = jpegBlob(product.image);
          const path = `${ownerId}/${product.id}/${crypto.randomUUID()}.jpg`;
          const { error } = await storage().upload(path, file, { contentType: "image/jpeg", upsert: false });
          if (error) throw error;
          uploadedPath = path;
          imagePath = path;
          image = await signedImage(path);
        } else if (product.imagePath && (product.image === PRODUCT_IMAGE_PLACEHOLDER || !isBuiltinImage(product.image))) {
          imagePath = product.imagePath;
          assertImagePath(imagePath, ownerId, product.id);
        } else if (isBuiltinImage(product.image)) {
          imagePath = product.image === PRODUCT_IMAGE_PLACEHOLDER ? null : product.image;
        } else if (product.image) {
          fail("Выберите фотографию заново: внешние ссылки не сохраняются в CRM.");
        }
        const row: ProductRow = {
          id: product.id, owner_id: ownerId, title: product.title.trim(), description: product.description,
          price: product.price, image_path: imagePath, stage: product.stage, category: product.category.trim(),
          views: product.views, favorites: product.favorites, created_at: timestamp(product.createdAt),
          sold_at: product.stage === "sold" ? timestamp(product.soldAt!) : null,
        };
        databaseAttempted = true;
        const query = existing
          ? client.from("products").update(row).eq("owner_id", ownerId).eq("id", product.id)
          : client.from("products").insert(row);
        const { data, error } = await query.select("*").single();
        if (error) {
          // A SQL rejection is definitive. Network/representation errors can follow a committed write.
          if (uploadedPath && /^(?:22|23|42)[A-Z0-9]{3}$/.test(String(error.code ?? ""))) await removeNewUpload(uploadedPath);
          throw error;
        }
        return mapProductRow(data as ProductRow, image);
      } catch (error) {
        if (uploadedPath && !databaseAttempted) await removeNewUpload(uploadedPath);
        throw error instanceof CrmError ? error : new CrmError(getCrmErrorMessage(error));
      }
    },

    async changeProductStage(id, stage, soldAt) {
      assertUuid(id);
      if (!STAGES.some((item) => item.id === stage)) fail("Выберите корректный этап товара.");
      if (stage === "sold" && !soldAt) fail("Для проданного товара нужна дата продажи.");
      const { data, error } = await client.from("products")
        .update({ stage, sold_at: stage === "sold" ? timestamp(soldAt!) : null })
        .eq("owner_id", ownerId).eq("id", id).select("*").single();
      if (error) throw new CrmError(getCrmErrorMessage(error));
      return productWithImage(data as ProductRow);
    },

    async saveBuyer(buyer, existing) {
      const row: BuyerRow = {
        id: buyer.id, owner_id: ownerId, name: buyer.name.trim(), phone: buyer.phone,
        product_id: buyer.productId || null, status: buyer.status, note: buyer.note,
      };
      mapBuyerRow(row);
      const query = existing
        ? client.from("buyers").update(row).eq("owner_id", ownerId).eq("id", buyer.id)
        : client.from("buyers").insert(row);
      const { data, error } = await query.select("*").single();
      if (error) throw new CrmError(getCrmErrorMessage(error));
      return mapBuyerRow(data as BuyerRow);
    },

    async updateBuyerStatus(id, status) {
      assertUuid(id);
      if (!BUYER_STATUSES.some((item) => item.id === status)) fail("Выберите корректный статус покупателя.");
      const { data, error } = await client.from("buyers").update({ status })
        .eq("owner_id", ownerId).eq("id", id).select("*").single();
      if (error) throw new CrmError(getCrmErrorMessage(error));
      return mapBuyerRow(data as BuyerRow);
    },

    async addMessage(message) {
      const row: MessageRow = {
        id: message.id, owner_id: ownerId, buyer_id: message.buyerId, text: message.text.trim(),
        direction: message.direction, created_at: timestamp(message.createdAt), read: message.read,
      };
      mapMessageRow(row);
      const { data, error } = await client.from("messages").insert(row).select("*").single();
      if (error) throw new CrmError(getCrmErrorMessage(error));
      return mapMessageRow(data as MessageRow);
    },

    async markBuyerMessagesRead(buyerId) {
      assertUuid(buyerId);
      const { error } = await client.from("messages").update({ read: true })
        .eq("owner_id", ownerId).eq("buyer_id", buyerId).eq("direction", "incoming").eq("read", false);
      if (error) throw new CrmError(getCrmErrorMessage(error));
    },
  };
}
