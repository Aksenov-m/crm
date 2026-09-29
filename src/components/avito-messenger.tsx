"use client";

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { AvitoRequestError, mergeAvitoMessages, type AvitoAccount, type AvitoChat, type AvitoMessage, type AvitoMessageEvent, type AvitoMessagesPage, type AvitoRealtimeState, type AvitoWebhookStatus, type createAvitoRepository } from "@/lib/avito";

type Repository = ReturnType<typeof createAvitoRepository>;
const errorText = (error: unknown) => error instanceof Error ? error.message : "Не удалось загрузить переписку Авито.";
const RECONNECT_COOLDOWN_MS = 30 * 1000;

// No periodic Avito requests. Sync on opening, visibility/reconnect, or manual refresh.
function useLiveQuery<T>(load: () => Promise<T>, paused = false, reconnect = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const reload = useRef<(manual?: boolean) => void>(() => {});
  const pausedRef = useRef(paused);
  useEffect(() => { pausedRef.current = paused; }, [paused]);
  useEffect(() => { if (reconnect) reload.current(); }, [reconnect]);
  useEffect(() => {
    let active = true;
    let pending = false;
    let nextAllowedAt = 0;
    let timer: ReturnType<typeof setTimeout>;
    async function run(manual = false) {
      if (!active || pending || pausedRef.current || document.hidden) return;
      clearTimeout(timer);
      const remaining = nextAllowedAt - Date.now();
      if (!manual && remaining > 0) {
        timer = setTimeout(run, remaining);
        return;
      }
      pending = true;
      setLoading(true);
      try { const result = await load(); if (active) { setData(result); setError(""); } }
      catch (cause) { if (active) setError(errorText(cause)); }
      finally {
        pending = false;
        nextAllowedAt = Date.now() + RECONNECT_COOLDOWN_MS;
        if (active) setLoading(false);
      }
    }
    reload.current = (manual = false) => { void run(manual); };
    const onVisibilityChange = () => { void run(); };
    void run();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => { active = false; clearTimeout(timer); reload.current = () => {}; document.removeEventListener("visibilitychange", onVisibilityChange); };
  }, [load]);
  return { data, error, loading, refresh: () => reload.current(true) };
}

function useReadReceipt(repository: Repository, accountKey: string, chatId: string, page: AvitoMessagesPage | null) {
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const acknowledged = useRef(new Set<string>());
  const pending = useRef<Promise<void> | null>(null);
  // Stable across polling. Only incoming messages need our read receipt.
  const unreadKey = JSON.stringify(page?.offset === 0 ? page.messages.filter((message) => message.direction === "in" && !message.isRead).map((message) => message.id).sort() : []);
  useEffect(() => {
    const ids: string[] = JSON.parse(unreadKey);
    if (!ids.length) { setError(""); setLoading(false); return; }
    let active = true;
    let running = false;
    async function markRead() {
      if (!active || running || document.hidden) return;
      running = true;
      setLoading(true);
      let request: Promise<void> | undefined;
      try {
        // A new incoming message may arrive while the previous receipt is pending.
        // Serialize receipts; never discard a confirmed receipt on a re-render.
        await pending.current?.catch(() => {});
        if (!active || document.hidden) return;
        const unread = ids.filter((id) => !acknowledged.current.has(id));
        if (!unread.length) { setError(""); return; }
        request = repository.readChat(accountKey, chatId, unread);
        pending.current = request;
        await request;
        for (const id of unread) acknowledged.current.add(id);
        if (active) setError("");
      } catch (cause) {
        if (active) {
          const status = cause instanceof AvitoRequestError && cause.status ? ` (HTTP ${cause.status})` : "";
          setError(`${errorText(cause)}${status}`);
        }
      } finally {
        if (request && pending.current === request) pending.current = null;
        running = false;
        if (active) setLoading(false);
      }
    }
    void markRead();
    document.addEventListener("visibilitychange", markRead);
    return () => { active = false; document.removeEventListener("visibilitychange", markRead); };
  }, [repository, accountKey, chatId, unreadKey, attempt]);
  return { error, loading, retry: () => setAttempt((value) => value + 1) };
}

function WebhookControl({ repository, accountKey }: { repository: Repository; accountKey: string }) {
  const [status, setStatus] = useState<AvitoWebhookStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void repository.webhookStatus(accountKey).then((value) => { if (active) setStatus(value); }).catch((cause) => { if (active) setError(errorText(cause)); });
    return () => { active = false; };
  }, [repository, accountKey]);
  async function enable() {
    setBusy(true); setError("");
    try { setStatus(await repository.enableWebhook(accountKey)); }
    catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }
  return <div className="space-y-2 rounded-xl border border-slate-200 p-3 text-sm">
    <p>{status?.enabled ? "Webhook зарегистрирован в Авито." : "Webhook ещё не подключён. Для автоматического получения сообщений настройте приёмник в Supabase."}</p>
    {status?.lastEventAt && <p className="text-slate-500">Последнее событие: {new Date(status.lastEventAt).toLocaleString("ru-RU")}</p>}
    {error && <p role="alert" className="form-error">{error}</p>}
    <button className="button button-secondary" disabled={busy} onClick={() => { void enable(); }}>{busy ? "Подключаем…" : status?.enabled ? "Проверить регистрацию webhook" : "Подключить webhook"}</button>
  </div>;
}

export function AvitoMessenger({ repository, onBusyChange }: { repository: Repository; onBusyChange: (busy: boolean) => void }) {
  const [accounts, setAccounts] = useState<AvitoAccount[]>([]);
  const [accountKey, setAccountKey] = useState("");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    setError("");
    void repository.accounts().then((items) => {
      if (!active) return;
      setAccounts(items); setAccountKey(items[0]?.key ?? "");
      if (!items.length) setError("Для вашего пользователя не настроен аккаунт Авито.");
    }).catch((cause) => { if (active) setError(errorText(cause)); });
    return () => { active = false; };
  }, [repository, attempt]);
  const changeBusy = useCallback((value: boolean) => { setBusy(value); onBusyChange(value); }, [onBusyChange]);
  return <section aria-label="Мессенджер Авито" className="space-y-4">
    <div className="flex flex-wrap items-center gap-3"><h2 className="text-xl font-semibold">Переписка Авито</h2><label className="field">Аккаунт для переписки<select className="input" value={accountKey} disabled={busy || !accounts.length} onChange={(event) => setAccountKey(event.target.value)}>{accounts.map((account) => <option key={account.key} value={account.key}>{account.name}</option>)}</select></label></div>
    <p className="text-sm text-slate-500">Новые сообщения поступают через webhook. Постоянный опрос Авито отключён; история сверяется при открытии чата и восстановлении соединения. Ответы отправляются покупателям в Авито.</p>
    {error && <div role="alert" className="form-error">{error} <button className="button button-secondary" onClick={() => setAttempt((value) => value + 1)}>Повторить подключение</button></div>}
    {!accountKey && !error && <p role="status">Загружаем аккаунты…</p>}
    {accountKey && <WebhookControl key={`webhook-${accountKey}`} repository={repository} accountKey={accountKey} />}
    {accountKey && <ChatList key={accountKey} repository={repository} accountKey={accountKey} busy={busy} onBusyChange={changeBusy} />}
  </section>;
}

function ChatList({ repository, accountKey, busy, onBusyChange }: { repository: Repository; accountKey: string; busy: boolean; onBusyChange: (busy: boolean) => void }) {
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<AvitoChat | null>(null);
  const [events, setEvents] = useState<AvitoMessageEvent[]>([]);
  const [connection, setConnection] = useState<AvitoRealtimeState>("connecting");
  const [reconnect, setReconnect] = useState(0);
  const load = useCallback(() => repository.chats(accountKey, offset), [repository, accountKey, offset]);
  const list = useLiveQuery(load, busy, reconnect);
  useEffect(() => {
    let connectedOnce = false;
    return repository.watchMessages(accountKey, (event) => setEvents((previous) => {
      const other = previous.filter((item) => item.chatId !== event.chatId || item.message.id !== event.message.id);
      const old = previous.find((item) => item.chatId === event.chatId && item.message.id === event.message.id);
      return [...other, { ...event, message: mergeAvitoMessages(old ? [old.message] : [], [event.message])[0] }].slice(-500);
    }), (state) => {
      setConnection(state);
      if (state === "connected") { if (connectedOnce) setReconnect((value) => value + 1); connectedOnce = true; }
    });
  }, [repository, accountKey]);
  const chatMap = new Map((list.data?.offset === offset ? list.data.chats : []).map((chat) => [chat.id, chat]));
  if (offset === 0) for (const event of events) {
    const existing = chatMap.get(event.chatId);
    const lastMessage = mergeAvitoMessages(existing?.lastMessage ? [existing.lastMessage] : [], [event.message]).at(-1)!;
    chatMap.set(event.chatId, { id: event.chatId, name: "Собеседник Авито", itemTitle: "", itemUrl: null, ...existing, lastMessage });
  }
  const chats = [...chatMap.values()].sort((a, b) => (b.lastMessage?.created ?? 0) - (a.lastMessage?.created ?? 0));
  return <div className="grid min-w-0 overflow-hidden rounded-2xl border border-slate-200 bg-white md:grid-cols-[280px_minmax(0,1fr)]">
    <aside aria-label="Диалоги Авито" className="min-w-0 border-b border-slate-200 md:border-r">
      <p role="status" className="px-3 pt-3 text-xs text-slate-500">{connection === "connected" ? "Обновления CRM подключены" : connection === "connecting" ? "Подключаем обновления…" : "Связь обновлений прервана. Переподключаемся…"}</p>
      <div className="flex flex-wrap items-center gap-2 p-3"><button className="button button-secondary" disabled={busy || list.loading} onClick={list.refresh}>Обновить диалоги</button>{list.loading && <span role="status">Загрузка…</span>}</div>
      {list.error && <p role="alert" className="form-error p-3">{list.error}</p>}
      {list.data?.warning && <p role="status" className="p-3 text-sm text-amber-700">{list.data.warning}</p>}
      <div className="max-h-72 overflow-y-auto md:max-h-[530px]">{chats.map((chat) => <button className={`block w-full min-w-0 border-b border-slate-100 p-4 text-left ${selected?.id === chat.id ? "bg-blue-50" : "hover:bg-slate-50"}`} key={chat.id} disabled={busy} aria-pressed={selected?.id === chat.id} onClick={() => setSelected(chat)}><strong className="block truncate">{chat.name}</strong><span className="block truncate text-xs text-slate-500">{chat.itemTitle || "Личный диалог"}</span><span className="mt-2 block truncate text-sm text-slate-600">{chat.lastMessage?.text || "Нет сообщений"}</span></button>)}</div>
      {!list.loading && !list.error && !chats.length && <p className="p-4 text-sm text-slate-500">Диалогов на этой странице нет.</p>}
      <div className="flex flex-wrap gap-2 p-3"><button className="button button-secondary" disabled={busy || list.loading || offset === 0} onClick={() => setOffset((value) => value - 50)}>Назад</button><button className="button button-secondary" disabled={busy || list.loading || list.data?.offset !== offset || !list.data.hasMore} onClick={() => setOffset((value) => value + 50)}>Следующие диалоги</button></div>
      {offset > 0 && <p className="p-3 text-xs text-slate-500">Новые диалоги ищите на первой странице.</p>}
    </aside>
    {selected ? <Chat key={selected.id} repository={repository} accountKey={accountKey} chat={selected} events={events} reconnect={reconnect} onBusyChange={onBusyChange} /> : <p className="p-8 text-slate-500">Выберите диалог, чтобы прочитать сообщения и ответить.</p>}
  </div>;
}

function Chat({ repository, accountKey, chat, events, reconnect, onBusyChange }: { repository: Repository; accountKey: string; chat: AvitoChat; events: AvitoMessageEvent[]; reconnect: number; onBusyChange: (busy: boolean) => void }) {
  const replyId = useId();
  const [offset, setOffset] = useState(0);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const [needsCheck, setNeedsCheck] = useState(false);
  const [sent, setSent] = useState<AvitoMessage[]>([]);
  const pendingSend = useRef(false);
  const end = useRef<HTMLDivElement>(null);
  const load = useCallback(() => repository.messages(accountKey, chat.id, offset), [repository, accountKey, chat.id, offset]);
  const history = useLiveQuery(load, sending, reconnect);
  const current = history.data?.offset === offset ? history.data : null;
  const messages = mergeAvitoMessages(current?.messages ?? [], offset === 0 ? sent : [], offset === 0 ? events.filter((event) => event.chatId === chat.id).map((event) => event.message) : []);
  const receipt = useReadReceipt(repository, accountKey, chat.id, messages.length ? { messages, offset, hasMore: current?.hasMore ?? false } : current);
  const lastId = offset === 0 ? messages.at(-1)?.id : "";
  useEffect(() => { end.current?.scrollIntoView({ block: "nearest" }); }, [lastId]);
  async function send(event: FormEvent) {
    event.preventDefault();
    if (pendingSend.current || needsCheck || !draft.trim() || draft.trim().length > 1000 || offset !== 0) return;
    pendingSend.current = true; setSending(true); onBusyChange(true); setSendError("");
    try {
      const message = await repository.sendMessage(accountKey, chat.id, draft.trim());
      setSent((items) => [...items, message]); setDraft("");
    } catch (cause) { setSendError(`${errorText(cause)} Перед повтором обновите переписку и проверьте, не появилось ли сообщение.`); setNeedsCheck(true); }
    finally { pendingSend.current = false; setSending(false); onBusyChange(false); }
  }
  return <div className="flex min-w-0 flex-col">
    <header className="border-b border-slate-100 p-4"><h3 className="font-semibold">{chat.name}</h3>{chat.itemUrl ? <a className="text-sm text-blue-600" href={chat.itemUrl} target="_blank" rel="noreferrer">{chat.itemTitle || "Объявление в Авито"}</a> : <p className="text-sm text-slate-500">{chat.itemTitle || "Личный диалог"}</p>}</header>
    <div className="flex flex-wrap gap-2 p-3"><button className="button button-secondary" disabled={sending || history.loading} onClick={history.refresh}>Обновить переписку</button><button className="button button-secondary" disabled={sending || history.loading || offset === 0} onClick={() => setOffset((value) => value - 50)}>Более новые</button><button className="button button-secondary" disabled={sending || history.loading || !current?.hasMore} onClick={() => setOffset((value) => value + 50)}>Более ранние</button></div>
    {history.error && <p role="alert" className="form-error px-4">{history.error}</p>}
    {current?.warning && <p role="status" className="px-4 py-2 text-sm text-amber-700">{current.warning}</p>}
    {receipt.error && <div role="status" className="space-y-2 px-4 py-3 text-sm text-amber-700"><p>Сообщения загружены, но Авито не подтвердило прочтение. {receipt.error}</p><button className="button button-secondary" disabled={receipt.loading || sending} onClick={receipt.retry}>{receipt.loading ? "Сохраняем прочтение…" : "Повторить отметку прочтения"}</button></div>}
    <div role="log" aria-label={`Переписка Авито: ${chat.name}`} aria-live="polite" className="h-96 space-y-3 overflow-y-auto bg-slate-50 p-4">
      {history.loading && !current && <p role="status">Загружаем сообщения…</p>}
      {messages.map((message) => <div key={message.id} className={`flex ${message.direction === "out" ? "justify-end" : "justify-start"}`}><div className={`max-w-[90%] rounded-xl p-3 ${message.direction === "out" ? "bg-blue-600 text-white" : "border border-slate-200 bg-white"}`}><p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{message.text}</p><p className="mt-1 text-xs opacity-70">{new Date(message.created * 1000).toLocaleString("ru-RU")}{message.direction === "out" ? " · Отправлено в Авито" : ""}</p></div></div>)}
      {!history.loading && current && !messages.length && <p>В этом диалоге пока нет сообщений.</p>}<div ref={end} />
    </div>
    <form onSubmit={send} className="space-y-2 border-t border-slate-100 p-4"><label className="field" htmlFor={replyId}>Ответ в Авито</label><textarea id={replyId} className="input min-h-24" value={draft} maxLength={1000} disabled={sending} onChange={(event) => setDraft(event.target.value)} /><p className="text-xs text-slate-500">{draft.length}/1000 · Текст будет отправлен покупателю, не сохранён как черновик.</p>
      {sendError && <p role="alert" className="form-error">{sendError}</p>}
      {needsCheck && <button type="button" className="button button-secondary" disabled={history.loading || !!history.error} onClick={() => { setNeedsCheck(false); setSendError(""); }}>Я проверил переписку — разрешить повтор</button>}
      {offset > 0 && <p className="text-sm text-slate-500">Вернитесь к последним сообщениям, чтобы ответить.</p>}
      <button className="button button-primary" disabled={sending || needsCheck || !draft.trim() || (!current && !messages.length) || offset !== 0}>{sending ? "Отправляем…" : "Отправить в Авито"}</button>
    </form>
  </div>;
}
