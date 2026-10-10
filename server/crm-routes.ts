import { Hono } from "hono";
import { AppEnv, requireUser } from "./auth.js";
import { pool } from "./db.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STAGES = new Set(["new", "preparing", "ready", "published", "sold"]);
const BUYER_STATUSES = new Set(["new", "negotiation", "sale", "rejected"]);
type Input = Record<string, unknown>;

function validDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function messageForDbError(error: unknown): { status: 400 | 409 | 500; body: { error: string; message: string; code?: string } } {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (code === "23503") return { status: 400, body: { error: "related_record", message: "Связанный товар или покупатель больше недоступен.", code } };
  if (code === "23505") return { status: 409, body: { error: "duplicate_record", message: "Такая запись уже существует.", code } };
  if (code === "23514" || code === "22P02" || code === "22003") return { status: 400, body: { error: "invalid_data", message: "Проверьте заполненные поля.", code } };
  return { status: 500, body: { error: "database_error", message: "Не удалось сохранить данные. Повторите позже." } };
}

function productInput(body: Input) {
  const id = typeof body.id === "string" ? body.id : "";
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const description = typeof body.description === "string" ? body.description : "";
  const category = typeof body.category === "string" ? body.category.trim() : "";
  const price = Number(body.price);
  const stage = typeof body.stage === "string" ? body.stage : "";
  const createdAt = validDate(body.createdAt);
  const soldAt = body.soldAt === undefined ? null : validDate(body.soldAt);
  const imagePath = typeof body.imagePath === "string" && body.imagePath ? body.imagePath : null;
  const views = Number(body.views ?? 0);
  const favorites = Number(body.favorites ?? 0);
  if (!UUID.test(id) || !title || title.length > 1000 || !category || category.length > 1000 || !Number.isFinite(price) || price < 0 || price >= 1e12 || !STAGES.has(stage) || !createdAt || !Number.isInteger(views) || views < 0 || !Number.isInteger(favorites) || favorites < 0 || (stage === "sold") !== Boolean(soldAt)) {
    return null;
  }
  return { id, title, description: description.slice(0, 20_000), category, price, stage, createdAt, soldAt, imagePath, views, favorites };
}

function buyerInput(body: Input) {
  const id = typeof body.id === "string" ? body.id : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const phone = typeof body.phone === "string" ? body.phone.slice(0, 80) : "";
  const productId = body.productId === "" || body.productId === null ? null : typeof body.productId === "string" ? body.productId : null;
  const status = typeof body.status === "string" ? body.status : "";
  const note = typeof body.note === "string" ? body.note.slice(0, 20_000) : "";
  if (!UUID.test(id) || !name || name.length > 500 || (productId !== null && !UUID.test(productId)) || !BUYER_STATUSES.has(status)) return null;
  return { id, name, phone, productId, status, note };
}

function mapProduct(row: Record<string, unknown>) {
  return {
    id: row.id, title: row.title, description: row.description, price: Number(row.price),
    imagePath: row.image_path ?? undefined, stage: row.stage, category: row.category,
    views: row.views, favorites: row.favorites,
    createdAt: new Date(String(row.created_at)).toISOString(),
    ...(row.sold_at ? { soldAt: new Date(String(row.sold_at)).toISOString() } : {}),
  };
}

function mapBuyer(row: Record<string, unknown>) {
  return { id: row.id, name: row.name, phone: row.phone, productId: row.product_id ?? "", status: row.status, note: row.note };
}

function mapMessage(row: Record<string, unknown>) {
  return { id: row.id, buyerId: row.buyer_id, text: row.text, direction: row.direction, createdAt: new Date(String(row.created_at)).toISOString(), read: row.read };
}

export const crmRoutes = new Hono<AppEnv>();
crmRoutes.use("*", requireUser);

crmRoutes.get("/", async (context) => {
  const ownerId = context.get("user").id;
  const [products, buyers, messages] = await Promise.all([
    pool.query("select * from products where owner_id = $1 order by created_at desc, id", [ownerId]),
    pool.query("select * from buyers where owner_id = $1 order by created_at, id", [ownerId]),
    pool.query("select * from messages where owner_id = $1 order by created_at, id", [ownerId]),
  ]);
  return context.json({ version: 1, products: products.rows.map(mapProduct), buyers: buyers.rows.map(mapBuyer), messages: messages.rows.map(mapMessage) });
});

crmRoutes.post("/products", async (context) => {
  let body: Input;
  try { body = await context.req.json(); } catch { return context.json({ error: "invalid_request", message: "Некорректный запрос." }, 400); }
  const product = productInput(body);
  if (!product) return context.json({ error: "invalid_product", message: "Проверьте название, цену, этап и дату продажи товара." }, 400);
  try {
    const { rows } = await pool.query(
      `insert into products(id,owner_id,title,description,price,image_path,stage,category,views,favorites,created_at,sold_at)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
      [product.id, context.get("user").id, product.title, product.description, product.price, product.imagePath, product.stage, product.category, product.views, product.favorites, product.createdAt, product.soldAt],
    );
    return context.json(mapProduct(rows[0]), 201);
  } catch (error) {
    const result = messageForDbError(error);
    return context.json(result.body, result.status);
  }
});

crmRoutes.put("/products/:id", async (context) => {
  const id = context.req.param("id");
  if (!UUID.test(id)) return context.json({ error: "invalid_id", message: "Некорректный идентификатор товара." }, 400);
  let body: Input;
  try { body = await context.req.json(); } catch { return context.json({ error: "invalid_request", message: "Некорректный запрос." }, 400); }
  const product = productInput({ ...body, id });
  if (!product) return context.json({ error: "invalid_product", message: "Проверьте название, цену, этап и дату продажи товара." }, 400);
  try {
    const { rows } = await pool.query(
      `update products set title=$3,description=$4,price=$5,image_path=$6,stage=$7,category=$8,views=$9,favorites=$10,created_at=$11,sold_at=$12
        where owner_id=$1 and id=$2 returning *`,
      [context.get("user").id, id, product.title, product.description, product.price, product.imagePath, product.stage, product.category, product.views, product.favorites, product.createdAt, product.soldAt],
    );
    return rows[0] ? context.json(mapProduct(rows[0])) : context.json({ error: "not_found", message: "Товар не найден." }, 404);
  } catch (error) {
    const result = messageForDbError(error);
    return context.json(result.body, result.status);
  }
});

crmRoutes.patch("/products/:id/stage", async (context) => {
  const id = context.req.param("id");
  if (!UUID.test(id)) return context.json({ error: "invalid_id", message: "Некорректный идентификатор товара." }, 400);
  let body: Input;
  try { body = await context.req.json(); } catch { return context.json({ error: "invalid_request", message: "Некорректный запрос." }, 400); }
  const stage = typeof body.stage === "string" ? body.stage : "";
  const soldAt = stage === "sold" ? validDate(body.soldAt) : null;
  if (!STAGES.has(stage) || (stage === "sold" && !soldAt)) return context.json({ error: "invalid_stage", message: "Выберите корректный этап товара." }, 400);
  const { rows } = await pool.query(
    "update products set stage=$3,sold_at=$4 where owner_id=$1 and id=$2 returning *",
    [context.get("user").id, id, stage, soldAt],
  );
  return rows[0] ? context.json(mapProduct(rows[0])) : context.json({ error: "not_found", message: "Товар не найден." }, 404);
});

crmRoutes.post("/buyers", async (context) => {
  let body: Input;
  try { body = await context.req.json(); } catch { return context.json({ error: "invalid_request", message: "Некорректный запрос." }, 400); }
  const buyer = buyerInput(body);
  if (!buyer) return context.json({ error: "invalid_buyer", message: "Проверьте имя, статус и товар покупателя." }, 400);
  try {
    const { rows } = await pool.query(
      "insert into buyers(id,owner_id,name,phone,product_id,status,note) values($1,$2,$3,$4,$5,$6,$7) returning *",
      [buyer.id, context.get("user").id, buyer.name, buyer.phone, buyer.productId, buyer.status, buyer.note],
    );
    return context.json(mapBuyer(rows[0]), 201);
  } catch (error) {
    const result = messageForDbError(error);
    return context.json(result.body, result.status);
  }
});

crmRoutes.put("/buyers/:id", async (context) => {
  const id = context.req.param("id");
  if (!UUID.test(id)) return context.json({ error: "invalid_id", message: "Некорректный идентификатор покупателя." }, 400);
  let body: Input;
  try { body = await context.req.json(); } catch { return context.json({ error: "invalid_request", message: "Некорректный запрос." }, 400); }
  const buyer = buyerInput({ ...body, id });
  if (!buyer) return context.json({ error: "invalid_buyer", message: "Проверьте имя, статус и товар покупателя." }, 400);
  try {
    const { rows } = await pool.query(
      "update buyers set name=$3,phone=$4,product_id=$5,status=$6,note=$7 where owner_id=$1 and id=$2 returning *",
      [context.get("user").id, id, buyer.name, buyer.phone, buyer.productId, buyer.status, buyer.note],
    );
    return rows[0] ? context.json(mapBuyer(rows[0])) : context.json({ error: "not_found", message: "Покупатель не найден." }, 404);
  } catch (error) {
    const result = messageForDbError(error);
    return context.json(result.body, result.status);
  }
});

crmRoutes.patch("/buyers/:id/status", async (context) => {
  const id = context.req.param("id");
  if (!UUID.test(id)) return context.json({ error: "invalid_id", message: "Некорректный идентификатор покупателя." }, 400);
  let body: Input;
  try { body = await context.req.json(); } catch { return context.json({ error: "invalid_request", message: "Некорректный запрос." }, 400); }
  const status = typeof body.status === "string" ? body.status : "";
  if (!BUYER_STATUSES.has(status)) return context.json({ error: "invalid_status", message: "Выберите корректный статус покупателя." }, 400);
  const { rows } = await pool.query("update buyers set status=$3 where owner_id=$1 and id=$2 returning *", [context.get("user").id, id, status]);
  return rows[0] ? context.json(mapBuyer(rows[0])) : context.json({ error: "not_found", message: "Покупатель не найден." }, 404);
});

crmRoutes.post("/messages", async (context) => {
  let body: Input;
  try { body = await context.req.json(); } catch { return context.json({ error: "invalid_request", message: "Некорректный запрос." }, 400); }
  const id = typeof body.id === "string" ? body.id : "";
  const buyerId = typeof body.buyerId === "string" ? body.buyerId : "";
  const text = typeof body.text === "string" ? body.text.trim() : "";
  const direction = typeof body.direction === "string" ? body.direction : "";
  const createdAt = validDate(body.createdAt);
  const read = typeof body.read === "boolean" ? body.read : false;
  if (!UUID.test(id) || !UUID.test(buyerId) || !text || text.length > 20_000 || !["incoming", "outgoing"].includes(direction) || !createdAt) return context.json({ error: "invalid_message", message: "Проверьте текст сообщения и покупателя." }, 400);
  try {
    const { rows } = await pool.query(
      "insert into messages(id,owner_id,buyer_id,text,direction,created_at,read) values($1,$2,$3,$4,$5,$6,$7) returning *",
      [id, context.get("user").id, buyerId, text, direction, createdAt, read],
    );
    return context.json(mapMessage(rows[0]), 201);
  } catch (error) {
    const result = messageForDbError(error);
    return context.json(result.body, result.status);
  }
});

crmRoutes.patch("/buyers/:id/messages-read", async (context) => {
  const id = context.req.param("id");
  if (!UUID.test(id)) return context.json({ error: "invalid_id", message: "Некорректный идентификатор покупателя." }, 400);
  await pool.query(
    "update messages set read=true where owner_id=$1 and buyer_id=$2 and direction='incoming' and read=false",
    [context.get("user").id, id],
  );
  return context.json({ ok: true });
});
