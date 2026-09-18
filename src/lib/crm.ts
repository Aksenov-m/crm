export type ProductStage = "new" | "preparing" | "ready" | "published" | "sold";
export type BuyerStatus = "new" | "negotiation" | "sale" | "rejected";

export interface Product {
  id: string;
  title: string;
  description: string;
  price: number;
  image: string;
  stage: ProductStage;
  category: string;
  views: number;
  favorites: number;
  createdAt: string;
  soldAt?: string;
}

export interface Buyer {
  id: string;
  name: string;
  phone: string;
  productId: string;
  status: BuyerStatus;
  note: string;
}

export interface Message {
  id: string;
  buyerId: string;
  text: string;
  direction: "incoming" | "outgoing";
  createdAt: string;
  read: boolean;
}

export interface DemoState {
  version: 1;
  products: Product[];
  buyers: Buyer[];
  messages: Message[];
}

export const STORAGE_KEY = "avito-crm-demo:v1";

export const STAGES: ReadonlyArray<{ id: ProductStage; label: string; color: string }> = [
  { id: "new", label: "Новый товар", color: "#94a3b8" },
  { id: "preparing", label: "Подготовка карточки", color: "#f3b546" },
  { id: "ready", label: "Готов к публикации", color: "#a78bfa" },
  { id: "published", label: "На Авито", color: "#3b82f6" },
  { id: "sold", label: "Продан", color: "#34b58a" },
];

export const BUYER_STATUSES: ReadonlyArray<{ id: BuyerStatus; label: string; color: string }> = [
  { id: "new", label: "Новый", color: "#3b82f6" },
  { id: "negotiation", label: "Переговоры", color: "#f3b546" },
  { id: "sale", label: "Продажа", color: "#34b58a" },
  { id: "rejected", label: "Отказ", color: "#94a3b8" },
];

const moneyFormatter = new Intl.NumberFormat("ru-RU", {
  style: "currency",
  currency: "RUB",
  maximumFractionDigits: 2,
  minimumFractionDigits: 0,
});

export function formatMoney(value: number): string {
  return moneyFormatter.format(value);
}

/** A fresh copy keeps separate SSR requests and demo resets independent. */
export function createInitialState(): DemoState {
  return {
    version: 1,
    products: [
      {
        id: "product-chair", title: "Кресло в скандинавском стиле", price: 12500,
        description: "Уютное кресло с деревянными ножками и мягкой светлой обивкой. Размеры: 74 × 80 × 86 см. Есть небольшая потёртость на подлокотнике.",
        image: "/products/chair.jpg", stage: "new", category: "Мебель", views: 0, favorites: 0,
        createdAt: "2026-09-17T08:30:00.000Z",
      },
      {
        id: "product-camera", title: "Фотоаппарат Sony с объективом", price: 62000,
        description: "Фотоаппарат Sony с объективом. В комплекте аккумулятор, зарядное устройство и ремешок. На корпусе есть следы использования.",
        image: "/products/camera.jpg", stage: "new", category: "Электроника", views: 0, favorites: 0,
        createdAt: "2026-09-17T07:15:00.000Z",
      },
      {
        id: "product-headphones", title: "Беспроводные наушники Sony", price: 14900,
        description: "Беспроводные наушники Sony. Чёрные, с чехлом и кабелем зарядки. На амбушюрах есть следы носки.",
        image: "/products/headphones.jpg", stage: "preparing", category: "Электроника", views: 0, favorites: 0,
        createdAt: "2026-09-16T12:20:00.000Z",
      },
      {
        id: "product-lamp", title: "Металлическая настольная лампа", price: 3800,
        description: "Настольная лампа с серым металлическим плафоном. Регулируемый наклон, цоколь E27. Лампочка в комплекте.",
        image: "/products/lamp.jpg", stage: "ready", category: "Для дома", views: 0, favorites: 0,
        createdAt: "2026-09-15T16:40:00.000Z",
      },
      {
        id: "product-bike", title: "Шоссейный велосипед Peugeot", price: 28500,
        description: "Велосипед Peugeot, рама M, колёса 28 дюймов. После сезонного обслуживания. Есть царапины на раме. Можно посмотреть и прокатиться перед покупкой.",
        image: "/products/bike.jpg", stage: "published", category: "Спорт и отдых", views: 348, favorites: 23,
        createdAt: "2026-09-12T09:00:00.000Z",
      },
      {
        id: "product-coffee", title: "Рожковая кофеварка для дома", price: 18900,
        description: "Рожковая кофеварка. Готовит эспрессо, есть ручной капучинатор. Выполнена очистка от накипи. Пользовались дома.",
        image: "/products/coffee.jpg", stage: "published", category: "Бытовая техника", views: 526, favorites: 41,
        createdAt: "2026-09-10T13:30:00.000Z",
      },
      {
        id: "product-speaker", title: "Портативная колонка JBL", price: 7900,
        description: "Портативная колонка JBL, чёрная. В комплекте коробка и кабель для зарядки. На корпусе есть небольшие потёртости.",
        image: "/products/speaker.jpg", stage: "sold", category: "Электроника", views: 284, favorites: 19,
        createdAt: "2026-09-04T10:00:00.000Z", soldAt: "2026-09-14T17:00:00.000Z",
      },
      {
        id: "product-console", title: "PlayStation 5 с геймпадом", price: 32900,
        description: "Sony PlayStation 5 с дисководом и одним геймпадом DualSense. В комплекте кабель питания и HDMI. Коробка сохранилась.",
        image: "/products/console.jpg", stage: "sold", category: "Электроника", views: 712, favorites: 52,
        createdAt: "2026-09-02T11:45:00.000Z", soldAt: "2026-09-16T15:30:00.000Z",
      },
    ],
    buyers: [
      { id: "buyer-alex", name: "Александр", phone: "", productId: "product-bike", status: "new", note: "Интересуется размером рамы. Предложить примерку." },
      { id: "buyer-anna", name: "Анна", phone: "", productId: "product-coffee", status: "negotiation", note: "Планирует забрать в выходные. Уточнить удобное время." },
      { id: "buyer-max", name: "Максим", phone: "", productId: "product-console", status: "sale", note: "Забрал приставку, всё проверили при встрече." },
      { id: "buyer-olga", name: "Ольга", phone: "", productId: "product-coffee", status: "rejected", note: "Выбрала другую модель." },
    ],
    messages: [
      { id: "message-1", buyerId: "buyer-alex", text: "Здравствуйте! Велосипед ещё продаётся? Подойдёт на рост 175 см?", direction: "incoming", createdAt: "2026-09-17T09:42:00.000Z", read: false },
      { id: "message-2", buyerId: "buyer-anna", text: "Добрый день! Можно посмотреть кофемашину в субботу?", direction: "incoming", createdAt: "2026-09-17T08:10:00.000Z", read: true },
      { id: "message-3", buyerId: "buyer-anna", text: "Здравствуйте, Анна! Да, в субботу я дома. В какое время вам удобно?", direction: "outgoing", createdAt: "2026-09-17T08:15:00.000Z", read: true },
      { id: "message-4", buyerId: "buyer-anna", text: "Отлично! Буду около 12. Адрес напишете?", direction: "incoming", createdAt: "2026-09-17T09:25:00.000Z", read: false },
      { id: "message-5", buyerId: "buyer-max", text: "Спасибо за приставку! Всё отлично работает.", direction: "incoming", createdAt: "2026-09-16T18:20:00.000Z", read: true },
      { id: "message-6", buyerId: "buyer-max", text: "Спасибо за покупку! Приятной игры.", direction: "outgoing", createdAt: "2026-09-16T18:25:00.000Z", read: true },
      { id: "message-7", buyerId: "buyer-olga", text: "Спасибо за ответ! Уже нашла подходящую модель.", direction: "incoming", createdAt: "2026-09-15T14:00:00.000Z", read: true },
    ],
  };
}

/** Local text template: no external AI, image analysis, or invented product facts. */
export function generateListing(input: { description: string; price: number; category: string }): { title: string; description: string } {
  const source = input.description.trim();
  if (!source) throw new RangeError("Добавьте описание товара.");
  if (!isAmount(input.price)) throw new RangeError("Укажите корректную цену.");

  const firstLine = source.split(/(?:\n|[.!?](?:\s|$))/u)[0].trim();
  const titleSource = (firstLine || source)
    .replace(/^(?:продаю|продам|продаётся|продается)\s+/iu, "")
    .replace(/\s+/gu, " ")
    .trim();
  const shortTitle = titleSource.length > 72
    ? `${titleSource.slice(0, 69).replace(/\s+\S*$/u, "").trimEnd()}…`
    : titleSource;
  const title = shortTitle.charAt(0).toLocaleUpperCase("ru-RU") + shortTitle.slice(1);
  const category = input.category.trim();
  const details = [category ? `Категория: ${category}` : "", `Цена: ${formatMoney(input.price)}`].filter(Boolean);

  return { title, description: `${source}\n\n${details.join("\n")}` };
}

/** Recording a sale twice must never shift its date or duplicate its revenue. */
export function moveProduct(state: DemoState, id: string, stage: ProductStage, now = new Date().toISOString()): DemoState {
  const product = state.products.find((item) => item.id === id);
  if (!product || !STAGES.some((item) => item.id === stage)) return state;
  if (product.stage === stage && (stage !== "sold" || product.soldAt)) return state;
  if (stage === "sold" && !isDate(now)) throw new RangeError("Некорректная дата продажи.");

  let updated: Product;
  if (stage === "sold") {
    updated = { ...product, stage, soldAt: product.soldAt ?? now };
  } else {
    const { soldAt: previousSale, ...unsold } = product;
    void previousSale;
    updated = { ...unsold, stage };
  }
  return { ...state, products: state.products.map((item) => item.id === id ? updated : item) };
}

export function getStats(state: DemoState): {
  revenue: number;
  activeListings: number;
  soldCount: number;
  totalViews: number;
  unreadCount: number;
  conversion: number;
} {
  const sold = state.products.filter((product) => product.stage === "sold");
  return {
    revenue: Math.round(sold.reduce((total, product) => total + product.price, 0) * 100) / 100,
    activeListings: state.products.filter((product) => product.stage === "published").length,
    soldCount: sold.length,
    totalViews: state.products.reduce((total, product) => total + product.views, 0),
    unreadCount: state.messages.filter((message) => message.direction === "incoming" && !message.read).length,
    conversion: state.products.length ? Math.round(sold.length / state.products.length * 1000) / 10 : 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNonEmptyString(value: unknown): value is string {
  return isString(value) && value.trim().length > 0;
}

function isAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

function isCount(value: unknown): value is number {
  return isAmount(value) && Number.isSafeInteger(value);
}

function isDate(value: unknown): value is string {
  if (!isString(value) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 19) === value.slice(0, 19);
}

function isImage(value: unknown): value is string {
  return isString(value) && (
    /^\/products\/[a-z\d_-]+\.(?:jpe?g|png|webp|avif)$/iu.test(value)
    || /^data:image\/(?:jpe?g|png|webp|gif|avif);base64,[a-z\d+/=\s]+$/iu.test(value)
  );
}

function isProduct(value: unknown): value is Product {
  return isRecord(value)
    && isNonEmptyString(value.id) && isNonEmptyString(value.title)
    && isString(value.description) && isAmount(value.price)
    && isImage(value.image) && STAGES.some((stage) => stage.id === value.stage)
    && isNonEmptyString(value.category) && isCount(value.views) && isCount(value.favorites)
    && isDate(value.createdAt) && (value.soldAt === undefined || isDate(value.soldAt));
}

function isBuyer(value: unknown): value is Buyer {
  return isRecord(value)
    && isNonEmptyString(value.id) && isNonEmptyString(value.name)
    && isString(value.phone) && isString(value.productId)
    && BUYER_STATUSES.some((status) => status.id === value.status)
    && isString(value.note);
}

function isMessage(value: unknown): value is Message {
  return isRecord(value)
    && isNonEmptyString(value.id) && isNonEmptyString(value.buyerId)
    && isNonEmptyString(value.text) && (value.direction === "incoming" || value.direction === "outgoing")
    && isDate(value.createdAt) && typeof value.read === "boolean";
}

function hasUniqueIds(items: Array<{ id: string }>): boolean {
  return new Set(items.map((item) => item.id)).size === items.length;
}

/** The browser may contain stale or edited data; never cast parsed JSON blindly. */
export function parseStoredState(raw: string): DemoState | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value.version !== 1
      || !Array.isArray(value.products) || !value.products.every(isProduct)
      || !Array.isArray(value.buyers) || !value.buyers.every(isBuyer)
      || !Array.isArray(value.messages) || !value.messages.every(isMessage)) return null;

    const products = value.products;
    const buyers = value.buyers;
    const messages = value.messages;
    if (!hasUniqueIds(products) || !hasUniqueIds(buyers) || !hasUniqueIds(messages)) return null;
    const productIds = new Set(products.map((product) => product.id));
    const buyerIds = new Set(buyers.map((buyer) => buyer.id));
    if (buyers.some((buyer) => buyer.productId !== "" && !productIds.has(buyer.productId))
      || messages.some((message) => !buyerIds.has(message.buyerId))) return null;

    return { version: 1, products, buyers, messages };
  } catch {
    return null;
  }
}
