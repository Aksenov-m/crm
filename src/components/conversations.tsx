"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { FileText, MessageCircle, Save, Search } from "lucide-react";
import { BUYER_STATUSES, formatMoney, type Buyer, type Message, type Product } from "@/lib/crm";

interface ConversationsProps {
  products: Product[];
  buyers: Buyer[];
  messages: Message[];
  selectedBuyerId: string | null;
  onSelectBuyer: (id: string) => void;
  onSend: (buyerId: string, text: string) => Promise<void>;
}

function initials(name: string) {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "П";
}

function messageTime(date: string) {
  const parsed = new Date(date);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

export function Conversations({ products, buyers, messages, selectedBuyerId, onSelectBuyer, onSend }: ConversationsProps) {
  const [query, setQuery] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const saveInProgress = useRef(false);
  const messageEnd = useRef<HTMLDivElement>(null);
  const draft = selectedBuyerId ? drafts[selectedBuyerId] ?? "" : "";
  const error = selectedBuyerId ? errors[selectedBuyerId] ?? "" : "";
  const selectedBuyer = buyers.find((buyer) => buyer.id === selectedBuyerId);
  const selectedProduct = products.find((product) => product.id === selectedBuyer?.productId);
  const conversation = messages.filter((message) => message.buyerId === selectedBuyerId);
  const unreadCount = messages.filter((message) => message.direction === "incoming" && !message.read).length;
  const normalizedQuery = query.trim().toLowerCase();
  const visibleBuyers = buyers.filter((buyer) => {
    const product = products.find((item) => item.id === buyer.productId);
    return `${buyer.name} ${product?.title ?? ""}`.toLowerCase().includes(normalizedQuery);
  }).sort((first, second) => {
    const firstLast = messages.filter((message) => message.buyerId === first.id).at(-1);
    const secondLast = messages.filter((message) => message.buyerId === second.id).at(-1);
    return (secondLast ? new Date(secondLast.createdAt).getTime() : 0) - (firstLast ? new Date(firstLast.createdAt).getTime() : 0);
  });

  useEffect(() => { messageEnd.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }, [selectedBuyerId, conversation.length]);

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedBuyer || !draft.trim() || saveInProgress.current) return;
    const buyerId = selectedBuyer.id;
    saveInProgress.current = true;
    setSaving(true);
    setErrors((current) => ({ ...current, [buyerId]: "" }));
    try {
      await onSend(buyerId, draft.trim());
      setDrafts((current) => ({ ...current, [buyerId]: "" }));
    } catch (cause) {
      setErrors((current) => ({ ...current, [buyerId]: cause instanceof Error ? cause.message : "Не удалось сохранить черновик. Попробуйте снова." }));
    } finally {
      saveInProgress.current = false;
      setSaving(false);
    }
  }

  return (
    <section aria-label="Сообщения" className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-slate-900">Все диалоги <span className="ml-2 text-base font-normal text-slate-400">{buyers.length}</span></h2>
          <p className="mt-1 text-sm text-slate-500">История и черновики по каждому покупателю.</p>
        </div>
      </div>

      <p className="rounded-xl border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-blue-800">Авито ещё не подключён. Черновики сохраняются в CRM и не отправляются покупателю.</p>

      <div className="grid overflow-hidden rounded-2xl border border-slate-200 bg-white md:h-[610px] md:grid-cols-[300px_minmax(0,1fr)] lg:grid-cols-[330px_minmax(0,1fr)]">
        <aside className="flex min-h-0 flex-col border-b border-slate-200 md:border-r md:border-b-0" aria-label="Список диалогов">
          <div className="border-b border-slate-100 p-5">
            <div className="mb-4 flex items-center justify-between">
              <span className="text-sm font-semibold text-slate-900">Входящие</span>
              <span className="rounded-full bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-600">Непрочитанных: {unreadCount}</span>
            </div>
            <div className="relative">
              <Search size={17} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-slate-400" />
              <input className="input pl-10!" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Найти диалог" aria-label="Поиск по имени или товару" />
            </div>
          </div>
          <div className="max-h-72 flex-1 overflow-y-auto md:max-h-none">
            {visibleBuyers.map((buyer, index) => {
              const buyerMessages = messages.filter((message) => message.buyerId === buyer.id);
              const lastMessage = buyerMessages.at(-1);
              const unread = buyerMessages.filter((message) => message.direction === "incoming" && !message.read).length;
              const product = products.find((item) => item.id === buyer.productId);
              const active = selectedBuyerId === buyer.id;
              return (
                <button key={buyer.id} type="button" disabled={saving} onClick={() => onSelectBuyer(buyer.id)} aria-pressed={active} className={`flex w-full items-start gap-3 border-b border-slate-100 px-5 py-5 text-left transition-colors ${active ? "border-l-[3px] border-l-blue-500 bg-blue-50/70 pl-[17px]" : "border-l-[3px] border-l-transparent pl-[17px] hover:bg-slate-50"}`}>
                  <span className={`flex size-10 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${["bg-indigo-100 text-indigo-600", "bg-orange-100 text-orange-600", "bg-teal-100 text-teal-600", "bg-violet-100 text-violet-600"][index % 4]}`}>{initials(buyer.name)}</span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-2"><span className="truncate text-sm font-semibold text-slate-800">{buyer.name}</span><span className="shrink-0 text-[11px] text-slate-400">{lastMessage ? messageTime(lastMessage.createdAt) : ""}</span></span>
                    <span className="mt-1 block truncate text-[11px] text-slate-400">{product?.title ?? "Товар не выбран"}</span>
                    <span className="mt-2 flex items-center gap-2"><span className={`block flex-1 truncate text-xs ${unread ? "font-medium text-slate-700" : "text-slate-500"}`}>{lastMessage ? `${lastMessage.direction === "outgoing" ? "Черновик: " : ""}${lastMessage.text}` : "Подготовьте первый черновик"}</span>{unread > 0 && <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-blue-600 text-[10px] font-semibold text-white" aria-label={`${unread} непрочитанных`}>{unread}</span>}</span>
                  </span>
                </button>
              );
            })}
            {visibleBuyers.length === 0 && <div className="px-6 py-12 text-center"><Search size={25} className="mx-auto mb-3 text-slate-300" /><p className="text-sm text-slate-500">{query ? "Диалоги не найдены" : "Здесь появятся ваши диалоги"}</p><p className="mt-2 text-xs text-slate-400">{query ? "Попробуйте другое имя или название товара." : "Добавьте покупателя, чтобы подготовить черновик."}</p></div>}
          </div>
        </aside>

        {selectedBuyer ? (
          <div className="flex min-h-[480px] min-w-0 flex-col md:min-h-0">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-6 py-4">
              <div className="flex items-center gap-3">
                <span className="flex size-10 items-center justify-center rounded-full bg-blue-100 text-xs font-semibold text-blue-600">{initials(selectedBuyer.name)}</span>
                <div><h3 className="text-sm font-semibold text-slate-900">{selectedBuyer.name}</h3><p className="mt-1 text-xs text-slate-400">{BUYER_STATUSES.find((status) => status.id === selectedBuyer.status)?.label ?? "Новый"}</p></div>
              </div>
              <span className="inline-flex items-center gap-1.5 rounded-md bg-slate-100 px-2 py-1 text-[10px] font-medium text-slate-500"><FileText size={12} /> Черновики CRM</span>
            </div>
            {selectedProduct && <div className="flex items-center gap-3 border-b border-slate-100 bg-slate-50/60 px-6 py-3">
              {/* User-uploaded data URLs and bundled assets are both supported. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={selectedProduct.image} alt={selectedProduct.title} className="size-10 rounded-lg bg-slate-100 object-cover" />
              <div className="min-w-0"><p className="truncate text-xs font-medium text-slate-700">{selectedProduct.title}</p><p className="mt-1 text-xs font-semibold text-slate-900">{formatMoney(selectedProduct.price)}</p></div>
            </div>}
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto bg-[#fbfcfe] px-4 py-6 sm:px-6" role="log" aria-label={`Переписка с ${selectedBuyer.name}`} aria-live="polite">
              <p className="mb-6 text-center text-[10px] text-slate-400">Черновики сохранены в базе CRM</p>
              {conversation.map((message) => <div key={message.id} className={`flex ${message.direction === "outgoing" ? "justify-end" : "justify-start"}`}><div className={`max-w-[88%] rounded-2xl px-4 py-3 sm:max-w-[75%] ${message.direction === "outgoing" ? "rounded-br-md bg-blue-600 text-white" : "rounded-bl-md border border-slate-200 bg-white text-slate-700"}`}><p className="text-sm leading-relaxed whitespace-pre-wrap break-words">{message.text}</p><div className={`mt-2 flex items-center justify-end gap-1.5 text-[10px] ${message.direction === "outgoing" ? "text-blue-200" : "text-slate-400"}`}><span>{messageTime(message.createdAt)}</span>{message.direction === "outgoing" && <span>Черновик · не отправлен</span>}</div></div></div>)}
              {conversation.length === 0 && <div className="flex h-40 flex-col items-center justify-center text-center"><MessageCircle className="mb-3 text-slate-300" size={32} /><p className="text-sm text-slate-500">Подготовьте сообщение</p><p className="mt-1 text-xs text-slate-400">Сохраните текст для этого покупателя.</p></div>}
              <div ref={messageEnd} />
            </div>
            <form onSubmit={sendMessage} className="border-t border-slate-100 bg-white px-4 py-4 sm:px-6">
              <div className="flex items-center gap-3"><input className="input min-w-0 flex-1" value={draft} disabled={saving} onChange={(event) => { const value = event.target.value; setDrafts((current) => ({ ...current, [selectedBuyer.id]: value })); }} maxLength={2000} aria-label="Текст сообщения" placeholder="Подготовьте черновик…" autoComplete="off" /><button type="submit" className="button button-primary shrink-0 px-3!" disabled={!draft.trim() || saving} aria-label={saving ? "Сохраняем черновик" : "Сохранить черновик"}><Save size={18} /></button></div>
              {error && <p className="form-error mt-2" role="alert">{error}</p>}
              <p className="mt-2 text-[10px] text-slate-400">{saving ? "Сохраняем черновик…" : "Enter — сохранить черновик в CRM"}</p>
            </form>
          </div>
        ) : <div className="flex min-h-[420px] flex-col items-center justify-center px-8 text-center"><span className="mb-5 flex size-16 items-center justify-center rounded-2xl bg-blue-50 text-blue-500"><MessageCircle size={29} strokeWidth={1.5} /></span><h3 className="text-base font-semibold text-slate-800">Черновики по каждому покупателю</h3><p className="mt-2 max-w-xs text-sm leading-relaxed text-slate-500">Выберите диалог слева или добавьте покупателя в разделе «Покупатели».</p></div>}
      </div>
    </section>
  );
}
