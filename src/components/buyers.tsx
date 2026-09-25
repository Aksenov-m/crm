"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowUpRight, MessageCircle, Package, Pencil, Phone, Plus, Search, StickyNote, Users, X } from "lucide-react";
import { BUYER_STATUSES, formatMoney, type Buyer, type Product } from "@/lib/crm";

interface BuyersProps {
  buyers: Buyer[];
  products: Product[];
  onAdd: (buyer: Buyer) => Promise<void>;
  onUpdate: (buyer: Buyer) => Promise<void>;
  onStatusChange: (id: string, status: Buyer["status"]) => Promise<void>;
  onOpenChat: (id: string) => void;
}

const statusClasses: Record<Buyer["status"], string> = {
  new: "bg-blue-50 text-blue-600",
  negotiation: "bg-amber-50 text-amber-700",
  sale: "bg-emerald-50 text-emerald-700",
  rejected: "bg-slate-100 text-slate-500",
};

const emptyDraft = { name: "", phone: "", productId: "", status: "new" as Buyer["status"], note: "" };

export function Buyers({ buyers, products, onAdd, onUpdate, onStatusChange, onOpenChat }: BuyersProps) {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [modalOpen, setModalOpen] = useState(false);
  const [editingBuyer, setEditingBuyer] = useState<Buyer | null>(null);
  const [draft, setDraft] = useState(emptyDraft);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [statusSaving, setStatusSaving] = useState<string | null>(null);
  const [statusError, setStatusError] = useState("");
  const saveInProgress = useRef(false);
  const newBuyerId = useRef<string | null>(null);
  const statusInProgress = useRef(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const normalizedQuery = query.trim().toLowerCase();
  const visibleBuyers = buyers.filter((buyer) => (statusFilter === "all" || buyer.status === statusFilter) && `${buyer.name} ${buyer.phone} ${products.find((product) => product.id === buyer.productId)?.title ?? ""}`.toLowerCase().includes(normalizedQuery));

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (modalOpen && !dialog.open) dialog.showModal();
    if (!modalOpen && dialog.open) dialog.close();
  }, [modalOpen]);

  function openEditor(buyer?: Buyer) {
    if (saveInProgress.current) return;
    newBuyerId.current = buyer?.id ?? crypto.randomUUID();
    setEditingBuyer(buyer ?? null);
    setDraft(buyer ? { name: buyer.name, phone: buyer.phone, productId: buyer.productId, status: buyer.status, note: buyer.note } : { ...emptyDraft });
    setError("");
    setModalOpen(true);
  }

  async function saveBuyer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saveInProgress.current) return;
    const name = draft.name.trim();
    const phone = draft.phone.trim();
    if (!name || name.length > 80) { setError("Введите имя покупателя — от 1 до 80 символов."); return; }
    if (phone && (!/^\+?[\d\s()\-]+$/.test(phone) || phone.replace(/\D/g, "").length < 7 || phone.replace(/\D/g, "").length > 15)) { setError("Введите корректный телефон: от 7 до 15 цифр, либо оставьте поле пустым."); return; }
    const buyer: Buyer = { id: editingBuyer?.id ?? (newBuyerId.current ??= crypto.randomUUID()), name, phone, productId: draft.productId, status: draft.status, note: draft.note.trim() };
    saveInProgress.current = true;
    setSaving(true);
    setError("");
    try {
      if (editingBuyer) await onUpdate(buyer); else await onAdd(buyer);
      setModalOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось сохранить покупателя. Попробуйте снова.");
    } finally {
      saveInProgress.current = false;
      setSaving(false);
    }
  }

  async function changeStatus(buyer: Buyer, status: Buyer["status"]) {
    if (statusInProgress.current) return;
    statusInProgress.current = true;
    setStatusSaving(buyer.id);
    setStatusError("");
    try { await onStatusChange(buyer.id, status); }
    catch (cause) { setStatusError(cause instanceof Error ? cause.message : "Не удалось сохранить статус покупателя."); }
    finally { statusInProgress.current = false; setStatusSaving(null); }
  }

  function closeEditor() {
    if (!saveInProgress.current) setModalOpen(false);
  }

  return (
    <section aria-label="Покупатели" className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div><h2 className="text-xl font-semibold tracking-tight text-slate-900">Ваши покупатели <span className="ml-2 text-base font-normal text-slate-400">{buyers.length}</span></h2><p className="mt-1 text-sm text-slate-500">Контакты, договорённости и следующий шаг по каждой сделке.</p></div>
        <button type="button" className="button button-primary" onClick={() => openEditor()}><Plus size={17} /> Добавить покупателя</button>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Фильтр по статусу покупателя">
          <button type="button" aria-pressed={statusFilter === "all"} className={`rounded-lg px-3 py-2 text-xs font-medium transition-colors ${statusFilter === "all" ? "bg-blue-50 text-blue-600" : "text-slate-500 hover:bg-slate-50"}`} onClick={() => setStatusFilter("all")}>Все <span className="ml-1 text-slate-400">{buyers.length}</span></button>
          {BUYER_STATUSES.map((status) => <button key={status.id} type="button" aria-pressed={statusFilter === status.id} className={`rounded-lg px-3 py-2 text-xs font-medium transition-colors ${statusFilter === status.id ? statusClasses[status.id] : "text-slate-500 hover:bg-slate-50"}`} onClick={() => setStatusFilter(status.id)}>{status.label} <span className="ml-1 opacity-60">{buyers.filter((buyer) => buyer.status === status.id).length}</span></button>)}
        </div>
        <div className="relative w-full sm:w-60"><Search size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-slate-400" /><input className="input pl-10!" type="search" placeholder="Поиск покупателей" aria-label="Поиск покупателей" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
      </div>

      {statusError && <p className="form-error" role="alert">{statusError}</p>}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {visibleBuyers.map((buyer, index) => {
          const product = products.find((item) => item.id === buyer.productId);
          return <article key={buyer.id} className="flex flex-col rounded-2xl border border-slate-200 bg-white p-5 transition-shadow hover:shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3"><span className={`flex size-11 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${["bg-indigo-100 text-indigo-600", "bg-orange-100 text-orange-600", "bg-teal-100 text-teal-600", "bg-violet-100 text-violet-600"][index % 4]}`}>{buyer.name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase()}</span><div className="min-w-0"><h3 className="truncate text-sm font-semibold text-slate-900">{buyer.name}</h3><span className={`mt-1.5 inline-flex rounded-md px-2 py-0.5 text-[10px] font-medium ${statusClasses[buyer.status]}`}>{BUYER_STATUSES.find((status) => status.id === buyer.status)?.label}</span></div></div>
              <button type="button" className="icon-button shrink-0" onClick={() => openEditor(buyer)} aria-label={`Редактировать покупателя ${buyer.name}`} title="Редактировать"><Pencil size={16} /></button>
            </div>
            <div className="mt-5 flex items-center gap-2 text-xs text-slate-500"><Phone size={14} className="text-slate-400" /><span>{buyer.phone || "Телефон не указан"}</span></div>
            <div className="mt-4 flex min-h-16 items-center gap-3 rounded-xl bg-slate-50 p-3">
              {product ? <>{/* eslint-disable-next-line @next/next/no-img-element */}<img src={product.image} alt={product.title} className="size-10 shrink-0 rounded-lg bg-slate-100 object-cover" /><div className="min-w-0"><p className="truncate text-xs font-medium text-slate-700">{product.title}</p><p className="mt-1 text-xs font-semibold text-slate-900">{formatMoney(product.price)}</p></div></> : <><span className="flex size-10 items-center justify-center rounded-lg bg-slate-100 text-slate-400"><Package size={19} /></span><span className="text-xs text-slate-400">Товар не выбран</span></>}
            </div>
            <div className="mt-4 flex flex-1 items-start gap-2 text-xs leading-relaxed text-slate-500"><StickyNote size={14} className="mt-0.5 shrink-0 text-slate-400" /><p className="line-clamp-3 min-h-10 break-words">{buyer.note || "Добавьте заметку о покупателе или детали встречи."}</p></div>
            <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-4">
              <select className="select max-w-[145px] text-xs!" value={buyer.status} disabled={statusSaving !== null} aria-label={`Статус покупателя ${buyer.name}`} onChange={(event) => { void changeStatus(buyer, event.target.value as Buyer["status"]); }}>{BUYER_STATUSES.map((status) => <option key={status.id} value={status.id}>{status.label}</option>)}</select>
              <button type="button" className="button button-ghost gap-1.5! px-2! text-xs!" onClick={() => onOpenChat(buyer.id)}><MessageCircle size={15} /> Открыть диалог <ArrowUpRight size={13} /></button>
            </div>
          </article>;
        })}
      </div>
      {visibleBuyers.length === 0 && <div className="flex min-h-72 flex-col items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-white p-8 text-center"><span className="mb-4 flex size-14 items-center justify-center rounded-2xl bg-blue-50 text-blue-500"><Users size={26} strokeWidth={1.5} /></span><h3 className="text-base font-semibold text-slate-800">{buyers.length ? "Покупатели не найдены" : "Первый покупатель — начало сделки"}</h3><p className="mt-2 max-w-sm text-sm text-slate-500">{buyers.length ? "Попробуйте изменить поиск или выбрать другой статус." : "Сохраните контакт, привяжите товар и держите договорённости под рукой."}</p><button type="button" className="button button-secondary mt-5" onClick={() => { if (buyers.length) { setQuery(""); setStatusFilter("all"); } else openEditor(); }}>{buyers.length ? "Сбросить фильтры" : "Добавить покупателя"}</button></div>}

      <dialog ref={dialogRef} className="modal-panel" aria-labelledby="buyer-dialog-title" onCancel={(event) => { event.preventDefault(); closeEditor(); }} onClose={closeEditor} onClick={(event) => { if (event.target === event.currentTarget) closeEditor(); }}>
        <form onSubmit={saveBuyer} onClick={(event) => event.stopPropagation()}>
          <div className="modal-header"><div><h2 id="buyer-dialog-title" className="text-lg font-semibold text-slate-900">{editingBuyer ? "Карточка покупателя" : "Новый покупатель"}</h2><p className="mt-1 text-sm text-slate-500">Все детали будущей сделки.</p></div><button type="button" className="icon-button" disabled={saving} onClick={closeEditor} aria-label="Закрыть карточку покупателя"><X size={20} /></button></div>
          <fieldset disabled={saving} className="contents">
          <div className="modal-body space-y-4">
            <label className="field" htmlFor="buyer-name"><span>Имя покупателя <span className="text-blue-500">*</span></span><input id="buyer-name" className="input" value={draft.name} onChange={(event) => { setDraft({ ...draft, name: event.target.value }); setError(""); }} required maxLength={80} placeholder="Например, Анна Смирнова" autoComplete="name" autoFocus /></label>
            <label className="field" htmlFor="buyer-phone"><span>Телефон <span className="font-normal text-slate-400">· необязательно</span></span><input id="buyer-phone" className="input" type="tel" value={draft.phone} onChange={(event) => { setDraft({ ...draft, phone: event.target.value }); setError(""); }} maxLength={30} placeholder="+7 (999) 123-45-67" autoComplete="tel" /></label>
            <label className="field" htmlFor="buyer-product">Интересующий товар<select id="buyer-product" className="select" value={draft.productId} onChange={(event) => setDraft({ ...draft, productId: event.target.value })}><option value="">Пока не выбран</option>{products.map((product) => <option key={product.id} value={product.id}>{product.title} · {formatMoney(product.price)}</option>)}</select></label>
            <label className="field" htmlFor="buyer-status">Статус<select id="buyer-status" className="select" value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value as Buyer["status"] })}>{BUYER_STATUSES.map((status) => <option key={status.id} value={status.id}>{status.label}</option>)}</select></label>
            <label className="field" htmlFor="buyer-note">Заметка<textarea id="buyer-note" className="textarea" rows={3} maxLength={1000} value={draft.note} onChange={(event) => setDraft({ ...draft, note: event.target.value })} placeholder="Что обсудили, когда встреча, о чём напомнить…" /></label>
            {error && <p className="form-error" role="alert">{error}</p>}
          </div>
          <div className="modal-footer"><button type="button" className="button button-secondary" onClick={closeEditor}>Отмена</button><button type="submit" className="button button-primary">{saving ? "Сохраняем…" : editingBuyer ? "Сохранить изменения" : "Создать покупателя"}</button></div>
          </fieldset>
        </form>
      </dialog>
    </section>
  );
}
