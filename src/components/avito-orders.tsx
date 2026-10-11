"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownToLine, ChevronLeft, ChevronRight, LoaderCircle, PackageCheck, RefreshCw, ShoppingBag, Truck } from "lucide-react";
import { AvitoRequestError, type AvitoAccount, type AvitoOrder, type AvitoOrdersPage, createAvitoRepository } from "@/lib/avito";

const STATUS_OPTIONS = [
  ["", "Все заказы"],
  ["on_confirmation", "Ожидают подтверждения"],
  ["ready_to_ship", "Ждут отправки"],
  ["in_transit", "В пути"],
  ["delivered", "Доставлены"],
  ["on_return", "Возврат"],
  ["in_dispute", "Спор"],
  ["canceled", "Отменены"],
  ["closed", "Закрыты"],
] as const;

const STATUS_LABELS: Record<string, string> = Object.fromEntries(STATUS_OPTIONS.filter(([value]) => value).map(([value, label]) => [value, label]));
const ACTION_LABELS: Record<string, string> = { confirm: "Подтвердить заказ", reject: "Отклонить", perform: "Передать в доставку", receive: "Подтвердить получение" };
const SERVICE_LABELS: Record<string, string> = { pvz: "Пункт выдачи", dbs: "Доставка продавца", rdbs: "Курьер продавца", postamat: "Постамат", cnc: "Самовывоз" };

function dateTime(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString("ru-RU", { dateStyle: "medium", timeStyle: "short" }) : "—";
}

function money(value?: number): string {
  return typeof value === "number" && Number.isFinite(value) ? new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB", maximumFractionDigits: 2 }).format(value) : "—";
}

function errorText(error: unknown): string {
  if (error instanceof AvitoRequestError && (error.code === "avito_access" || error.status === 403)) {
    return "Авито отклонило доступ к заказам для этого ключа. По спецификации API заказов доступно продавцам B2C; проверьте в кабинете Авито тип продавца и права приложения Business API.";
  }
  return error instanceof Error ? error.message : "Не удалось загрузить заказы Авито.";
}

type Props = { repository: ReturnType<typeof createAvitoRepository>; onBusyChange: (busy: boolean) => void; onOpenSettings: () => void };

export function AvitoOrders({ repository, onBusyChange, onOpenSettings }: Props) {
  const [accounts, setAccounts] = useState<AvitoAccount[]>([]);
  const [accountKey, setAccountKey] = useState("");
  const [status, setStatus] = useState("");
  const [pageNumber, setPageNumber] = useState(1);
  const [page, setPage] = useState<AvitoOrdersPage | null>(null);
  const [loadingAccounts, setLoadingAccounts] = useState(true);
  const [loadingOrders, setLoadingOrders] = useState(false);
  const [error, setError] = useState("");
  const [busyOrderId, setBusyOrderId] = useState("");
  const [trackingOrderId, setTrackingOrderId] = useState("");
  const [trackingNumber, setTrackingNumber] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [labelTask, setLabelTask] = useState<{ accountKey: string; id: string } | null>(null);
  const [labelsBusy, setLabelsBusy] = useState(false);
  const requestCounter = useRef(0);

  useEffect(() => {
    let current = true;
    onBusyChange(true);
    repository.accounts().then((values) => {
      if (!current) return;
      setAccounts(values);
      setAccountKey((selectedKey) => selectedKey && values.some((account) => account.key === selectedKey) ? selectedKey : values[0]?.key || "");
    }).catch((cause) => { if (current) setError(errorText(cause)); }).finally(() => {
      if (current) setLoadingAccounts(false);
      onBusyChange(false);
    });
    return () => { current = false; };
  }, [repository, onBusyChange]);

  const loadOrders = useCallback(async () => {
    if (!accountKey) { setPage(null); return; }
    const requestId = ++requestCounter.current;
    setLoadingOrders(true);
    setError("");
    onBusyChange(true);
    try {
      const result = await repository.orders(accountKey, pageNumber, status);
      if (requestId === requestCounter.current) setPage(result);
    } catch (cause) {
      if (requestId === requestCounter.current) { setPage(null); setError(errorText(cause)); }
    } finally {
      if (requestId === requestCounter.current) setLoadingOrders(false);
      onBusyChange(false);
    }
  }, [accountKey, pageNumber, status, repository, onBusyChange]);

  useEffect(() => { void loadOrders(); }, [loadOrders]);

  const accountName = useMemo(() => accounts.find((account) => account.key === accountKey)?.name || "", [accounts, accountKey]);
  useEffect(() => { setSelected(new Set()); }, [accountKey, status, pageNumber]);

  async function runOrderAction(order: AvitoOrder, action: "confirm" | "reject" | "perform" | "receive") {
    const confirmation = action === "reject" ? "Отклонить заказ в Авито? Покупатель увидит изменение статуса." : action === "confirm" ? "Подтвердить заказ в Авито?" : action === "perform" ? "Передать заказ в доставку?" : "Подтвердить получение заказа?";
    if (!window.confirm(confirmation)) return;
    setBusyOrderId(order.id);
    setError("");
    onBusyChange(true);
    try {
      await repository.transitionOrder(accountKey, order.id, action);
      await loadOrders();
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusyOrderId(""); onBusyChange(false); }
  }

  async function saveTrackingNumber(event: React.FormEvent<HTMLFormElement>, order: AvitoOrder) {
    event.preventDefault();
    const value = trackingNumber.trim();
    if (!value) return;
    setBusyOrderId(order.id);
    setError("");
    onBusyChange(true);
    try {
      await repository.setOrderTrackingNumber(accountKey, order.id, value);
      setTrackingOrderId("");
      setTrackingNumber("");
      await loadOrders();
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusyOrderId(""); onBusyChange(false); }
  }

  function toggleSelected(order: AvitoOrder) {
    setSelected((current) => {
      const next = new Set(current);
      next.has(order.id) ? next.delete(order.id) : next.add(order.id);
      return next;
    });
  }

  async function createLabels() {
    const orders = page?.orders.filter((order) => selected.has(order.id)) || [];
    if (!orders.length) return;
    setLabelsBusy(true);
    setError("");
    onBusyChange(true);
    try {
      const result = await repository.createOrderLabels(accountKey, orders.map((order) => order.marketplaceId || order.id));
      setLabelTask({ accountKey, id: result.taskId });
      setSelected(new Set());
    } catch (cause) { setError(errorText(cause)); }
    finally { setLabelsBusy(false); onBusyChange(false); }
  }

  async function downloadLabels() {
    if (!labelTask) return;
    setLabelsBusy(true);
    setError("");
    onBusyChange(true);
    try {
      const blob = await repository.downloadOrderLabels(labelTask.accountKey, labelTask.id);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "etiketki-avito.pdf";
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) { setError(errorText(cause)); }
    finally { setLabelsBusy(false); onBusyChange(false); }
  }

  const orders = page?.orders || [];
  const allVisibleSelected = orders.length > 0 && orders.every((order) => selected.has(order.id));

  return <section className="space-y-5" aria-label="Заказы Авито">
    <div className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-600"><ShoppingBag size={21} /></span>
          <div><h2 className="text-lg font-semibold text-slate-900">Заказы Авито</h2><p className="mt-1 text-sm text-slate-500">Заказы, доставка и этикетки из подключённого аккаунта.</p></div>
        </div>
        <button className="button button-secondary" onClick={() => void loadOrders()} disabled={loadingOrders || loadingAccounts || !accountKey}><RefreshCw size={15} className={loadingOrders ? "animate-spin" : ""} />Обновить</button>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <label className="field">Аккаунт Авито<select className="select mt-2" value={accountKey} disabled={loadingAccounts || !accounts.length} onChange={(event) => { setAccountKey(event.target.value); setPageNumber(1); setSelected(new Set()); }}><option value="">{loadingAccounts ? "Загружаем аккаунты…" : accounts.length ? "Выберите аккаунт" : "Нет настроенных аккаунтов"}</option>{accounts.map((account) => <option value={account.key} key={account.key}>{account.name}{account.avitoUserId ? ` · ID ${account.avitoUserId}` : ""}</option>)}</select></label>
        <label className="field">Статус заказа<select className="select mt-2" value={status} disabled={!accountKey} onChange={(event) => { setStatus(event.target.value); setPageNumber(1); }} aria-label="Фильтр по статусу заказа">{STATUS_OPTIONS.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
      </div>

      {!loadingAccounts && accounts.length === 0 && <div className="mt-4 rounded-xl border border-dashed border-slate-300 bg-slate-50 p-4 text-sm text-slate-600"><p>Сначала добавьте ключи аккаунта Авито с правами Business API.</p><button className="button button-secondary mt-3" onClick={onOpenSettings}>Открыть настройки Авито</button></div>}
      {accountName && <p className="mt-3 text-xs text-slate-400">Источник: {accountName} · данные загружаются напрямую из Авито.</p>}
      {error && <div className="mt-4 rounded-xl border border-red-100 bg-red-50 p-4 text-sm leading-relaxed text-red-800" role="alert">{error}{(error.includes("доступ к заказам") || error.includes("права приложения")) && <button className="ml-2 font-semibold underline" onClick={onOpenSettings}>Настройки Авито</button>}</div>}
    </div>

    {labelTask && <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-blue-100 bg-blue-50 p-4 text-sm text-blue-900"><span>Авито создало задачу этикеток {labelTask.id}. Если PDF ещё не готов, повторите скачивание позже.</span><button className="button button-primary" onClick={() => void downloadLabels()} disabled={labelsBusy}><ArrowDownToLine size={16} />Скачать PDF</button></div>}

    {orders.length > 0 && <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-3"><label className="flex items-center gap-2 text-sm text-slate-600"><input type="checkbox" checked={allVisibleSelected} onChange={() => setSelected((current) => { const next = new Set(current); if (allVisibleSelected) orders.forEach((order) => next.delete(order.id)); else orders.forEach((order) => next.add(order.id)); return next; })} />Выбрать заказы на странице</label><button className="button button-secondary" onClick={() => void createLabels()} disabled={!selected.size || labelsBusy}><PackageCheck size={16} />Создать этикетки{selected.size ? ` · ${selected.size}` : ""}</button></div>}

    {loadingOrders && !orders.length && <div className="flex min-h-48 items-center justify-center rounded-2xl border border-slate-200 bg-white text-sm text-slate-500"><LoaderCircle size={18} className="mr-2 animate-spin" />Загружаем заказы Авито…</div>}
    {!loadingOrders && !error && accountKey && !orders.length && <div className="flex min-h-48 flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center"><ShoppingBag size={27} className="text-slate-300" /><h3 className="mt-3 font-semibold text-slate-700">Заказов нет</h3><p className="mt-1 text-sm text-slate-500">В выбранном аккаунте и статусе Авито не вернуло заказы.</p></div>}

    <div className="space-y-3">
      {orders.map((order) => {
        const actions = new Set((order.availableActions || []).map((action) => action.name));
        const isBusy = busyOrderId === order.id;
        const canSetTracking = actions.has("setTrackNumber") || actions.has("fixTrackNumber");
        return <article key={order.id} className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold text-slate-900">Заказ № {order.id}</h3><span className="rounded-full bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700">{STATUS_LABELS[order.status] || order.status}</span></div><p className="mt-1 text-xs text-slate-400">Создан {dateTime(order.createdAt)}{order.updatedAt && order.updatedAt !== order.createdAt ? ` · обновлён ${dateTime(order.updatedAt)}` : ""}</p></div>
            <label className="flex items-center gap-2 text-xs text-slate-500"><input type="checkbox" checked={selected.has(order.id)} onChange={() => toggleSelected(order)} />Этикетка</label>
          </div>

          <div className="mt-4 divide-y divide-slate-100 rounded-xl border border-slate-100 bg-slate-50/70">
            {order.items.map((item, index) => <div key={`${item.avitoId}-${index}`} className="flex flex-wrap items-center justify-between gap-3 p-3"><div className="min-w-0"><p className="break-words text-sm font-medium text-slate-800">{item.title || `Объявление ${item.avitoId}`}</p><p className="mt-1 text-xs text-slate-500">Авито ID {item.avitoId} · количество {item.count}{item.location ? ` · ${item.location}` : ""}</p></div><strong className="text-sm text-slate-800">{money(item.prices?.total ?? item.prices?.price)}</strong></div>)}
          </div>

          <div className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
            <div className="rounded-xl border border-slate-100 p-3"><p className="text-xs text-slate-400">Доставка</p><p className="mt-1 font-medium text-slate-700">{SERVICE_LABELS[order.delivery?.serviceType || ""] || order.delivery?.serviceName || "Не указана"}</p>{order.delivery?.terminalInfo?.address && <p className="mt-1 text-xs text-slate-500">ПВЗ: {order.delivery.terminalInfo.address}</p>}{order.delivery?.courierInfo?.address && <p className="mt-1 text-xs text-slate-500">Адрес: {order.delivery.courierInfo.address}</p>}{order.delivery?.trackingNumber && <p className="mt-1 text-xs text-slate-500">Трек-номер: {order.delivery.trackingNumber}</p>}</div>
            <div className="rounded-xl border border-slate-100 p-3"><p className="text-xs text-slate-400">Итого</p><p className="mt-1 font-semibold text-slate-900">{money(order.prices?.total ?? order.prices?.price)}</p><p className="mt-1 text-xs text-slate-500">Комиссия {money(order.prices?.commission)}{typeof order.prices?.delivery === "number" ? ` · доставка ${money(order.prices.delivery)}` : ""}</p>{order.schedules?.confirmTill && <p className="mt-1 text-xs text-amber-700">Подтвердить до {dateTime(order.schedules.confirmTill)}</p>}{order.schedules?.shipTill && <p className="mt-1 text-xs text-amber-700">Отправить до {dateTime(order.schedules.shipTill)}</p>}</div>
          </div>

          {order.delivery?.buyerInfo && <p className="mt-3 text-sm text-slate-600">Покупатель: {order.delivery.buyerInfo.fullName || "Имя не указано"}{order.delivery.buyerInfo.phoneNumber ? ` · ${order.delivery.buyerInfo.phoneNumber}` : ""}</p>}

          <div className="mt-4 flex flex-wrap gap-2">
            {(["confirm", "reject", "perform", "receive"] as const).filter((action) => actions.has(action)).map((action) => <button key={action} className={action === "reject" ? "button button-secondary text-red-700" : "button button-secondary"} disabled={isBusy || loadingOrders} onClick={() => void runOrderAction(order, action)}>{isBusy ? <LoaderCircle size={15} className="animate-spin" /> : action === "perform" ? <Truck size={15} /> : <PackageCheck size={15} />}{ACTION_LABELS[action]}</button>)}
            {canSetTracking && <button className="button button-secondary" disabled={isBusy || loadingOrders} onClick={() => { setTrackingOrderId((current) => current === order.id ? "" : order.id); setTrackingNumber(order.delivery?.trackingNumber || ""); }}><Truck size={15} />{actions.has("fixTrackNumber") ? "Исправить трек-номер" : "Указать трек-номер"}</button>}
            {(order.availableActions || []).some((action) => !["confirm", "reject", "perform", "receive", "setTrackNumber", "fixTrackNumber"].includes(action.name)) && <span className="self-center text-xs text-slate-400">Для остальных операций откройте заказ в кабинете Авито.</span>}
          </div>

          {trackingOrderId === order.id && canSetTracking && <form className="mt-3 flex flex-col gap-2 rounded-xl bg-slate-50 p-3 sm:flex-row" onSubmit={(event) => void saveTrackingNumber(event, order)}><label className="sr-only" htmlFor={`tracking-${order.id}`}>Трек-номер</label><input id={`tracking-${order.id}`} className="input min-w-0 flex-1" value={trackingNumber} maxLength={200} required placeholder="Введите трек-номер" onChange={(event) => setTrackingNumber(event.target.value)} /><button className="button button-primary" disabled={isBusy || !trackingNumber.trim()}>{isBusy ? <LoaderCircle size={15} className="animate-spin" /> : <Truck size={15} />}Передать в Авито</button></form>}
        </article>;
      })}
    </div>

    {page && (pageNumber > 1 || page.hasMore) && <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-white p-3"><button className="button button-secondary" disabled={pageNumber <= 1 || loadingOrders} onClick={() => setPageNumber((value) => Math.max(1, value - 1))}><ChevronLeft size={16} />Назад</button><span className="text-sm text-slate-500">Страница {pageNumber} · загружено {orders.length}</span><button className="button button-secondary" disabled={!page.hasMore || loadingOrders} onClick={() => setPageNumber((value) => value + 1)}>Дальше<ChevronRight size={16} /></button></div>}
  </section>;
}
