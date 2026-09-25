"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { createCrmRepository, getCrmErrorMessage } from "@/lib/crm-repository";
import {
  ArrowDownUp, ArrowRight, ArrowUpRight, BarChart3, Bell, Check,
  CheckCheck, CheckCircle2, ChevronDown, ChevronRight, CircleHelp,
  Eye, GripVertical, Heart, LayoutGrid, List, MessageCircle, MoreHorizontal,
  Package, Plus, Search, ShoppingBag, Sparkles, Users, Wallet, X,
} from "lucide-react";
import {
  formatMoney, getStats, moveProduct,
  STAGES, type Buyer, type BuyerStatus, type DemoState, type Product, type ProductStage,
} from "@/lib/crm";
import { ProductEditor } from "./product-editor";
import { Conversations } from "./conversations";
import { Buyers } from "./buyers";

type Page = "products" | "messages" | "buyers" | "analytics";
const NAVIGATION = [
  { id: "products" as const, label: "Товары", icon: Package },
  { id: "messages" as const, label: "Сообщения", icon: MessageCircle },
  { id: "buyers" as const, label: "Покупатели", icon: Users },
  { id: "analytics" as const, label: "Аналитика", icon: BarChart3 },
];

function Logo() {
  return <span className="brand-mark" aria-hidden="true"><svg viewBox="0 0 32 32"><path d="M6 8h16l-5 8H6zm12 8h9L17 27H7z" fill="currentColor" /></svg></span>;
}

export function CrmApp({ client, user, onLogout }: { client: SupabaseClient; user: User; onLogout: () => Promise<void> }) {
  const repository = useMemo(() => createCrmRepository(client, user.id), [client, user.id]);
  const [state, setState] = useState<DemoState>({ version: 1, products: [], buyers: [], messages: [] });
  const [hydrated, setHydrated] = useState(false);
  const [storageError, setStorageError] = useState("");
  const [page, setPage] = useState<Page>("products");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [sort, setSort] = useState("newest");
  const [view, setView] = useState<"board" | "list">("board");
  const [editor, setEditor] = useState<{ product?: Product; initialStage?: ProductStage } | null>(null);
  const [selectedBuyer, setSelectedBuyer] = useState<string | null>(null);
  const [toast, setToast] = useState("");
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [overStage, setOverStage] = useState<ProductStage | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const notificationPanel = useRef<HTMLDivElement>(null);
  const active = useRef(false);
  const revision = useRef(0);
  const loading = useRef(false);
  const pending = useRef(new Set<string>());
  const draftRequests = useRef(new Map<string, { id: string; text: string; createdAt: string }>());
  const lastLoaded = useRef(0);
  const [busy, setBusy] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  async function refreshData() {
    if (loading.current || pending.current.size) return;
    const requestRevision = ++revision.current;
    loading.current = true;
    setRefreshing(true);
    try {
      const loaded = await repository.load();
      if (!active.current || requestRevision !== revision.current) return;
      setState(loaded);
      setHydrated(true);
      setStorageError("");
      lastLoaded.current = Date.now();
    } catch (error) {
      if (active.current && requestRevision === revision.current) setStorageError(getCrmErrorMessage(error));
    } finally {
      loading.current = false;
      if (active.current) setRefreshing(false);
    }
  }

  useEffect(() => {
    active.current = true;
    void refreshData();
    return () => { active.current = false; revision.current += 1; loading.current = false; };
  }, [repository]);

  useEffect(() => {
    const refreshStale = () => {
      if (document.visibilityState === "visible" && !editor && !document.querySelector("dialog[open]") && Date.now() - lastLoaded.current > 45 * 60 * 1000) void refreshData();
    };
    const interval = setInterval(refreshStale, 60000);
    window.addEventListener("focus", refreshStale);
    return () => { clearInterval(interval); window.removeEventListener("focus", refreshStale); };
  }, [repository, editor]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 4500);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!notificationsOpen) return;
    const close = (event: PointerEvent) => {
      if (!notificationPanel.current?.contains(event.target as Node)) setNotificationsOpen(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setNotificationsOpen(false); };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, [notificationsOpen]);

  const stats = getStats(state);
  const categories = [...new Set(state.products.map((p) => p.category))];
  const visibleProducts = useMemo(() => state.products.filter((product) => {
    const match = `${product.title} ${product.description}`.toLocaleLowerCase("ru").includes(search.toLocaleLowerCase("ru"));
    return match && (category === "all" || product.category === category);
  }).sort((a, b) => sort === "price-asc" ? a.price - b.price : sort === "price-desc" ? b.price - a.price : b.createdAt.localeCompare(a.createdAt)), [state.products, search, category, sort]);

  async function mutate<T,>(key: string, operation: () => Promise<T>, commit: (result: T) => void) {
    if (pending.current.has(key)) throw new Error("Сохранение уже выполняется.");
    pending.current.add(key);
    revision.current += 1;
    setBusy(true);
    try {
      const result = await operation();
      if (active.current) { commit(result); setStorageError(""); }
      return result;
    } finally {
      pending.current.delete(key);
      if (active.current) setBusy(pending.current.size > 0);
    }
  }

  function openChat(id: string) {
    setSelectedBuyer(id);
    setPage("messages");
    setNotificationsOpen(false);
    if (!state.messages.some((message) => message.buyerId === id && message.direction === "incoming" && !message.read)) return;
    void mutate(`read:${id}`, () => repository.markBuyerMessagesRead(id), () => {
      setState((current) => ({ ...current, messages: current.messages.map((message) => message.buyerId === id && message.direction === "incoming" ? { ...message, read: true } : message) }));
    }).catch((error) => { if (active.current) setStorageError(getCrmErrorMessage(error)); });
  }

  async function changeStage(id: string, stage: ProductStage) {
    setDraggedId(null); setOverStage(null);
    const moved = moveProduct(state, id, stage).products.find((product) => product.id === id);
    if (!moved) return;
    try {
      await mutate(`product:${id}`, () => repository.changeProductStage(id, stage, moved.soldAt), (saved) => {
        setState((current) => ({ ...current, products: current.products.map((item) => item.id === id ? saved : item) }));
        setToast(`Товар перемещён: ${STAGES.find((item) => item.id === stage)?.label}`);
      });
    } catch (error) { if (active.current) setStorageError(getCrmErrorMessage(error)); }
  }

  async function saveProduct(product: Product) {
    const existing = Boolean(editor?.product);
    await mutate(`product:${product.id}`, () => repository.saveProduct(product, existing), (saved) => {
      setState((current) => ({ ...current, products: existing ? current.products.map((item) => item.id === saved.id ? saved : item) : [saved, ...current.products] }));
      setToast(existing ? "Изменения сохранены" : "Объявление добавлено на доску");
      setEditor(null);
    });
  }

  async function saveBuyer(buyer: Buyer, existing: boolean) {
    await mutate(`buyer:${buyer.id}`, () => repository.saveBuyer(buyer, existing), (saved) => {
      setState((current) => ({ ...current, buyers: existing ? current.buyers.map((item) => item.id === saved.id ? saved : item) : [...current.buyers, saved] }));
      setToast(existing ? "Карточка покупателя обновлена" : "Покупатель добавлен");
    });
  }

  async function changeBuyerStatus(id: string, status: BuyerStatus) {
    await mutate(`buyer:${id}`, () => repository.updateBuyerStatus(id, status), (saved) => {
      setState((current) => ({ ...current, buyers: current.buyers.map((item) => item.id === id ? saved : item) }));
    });
  }

  async function saveDraft(buyerId: string, text: string) {
    const previous = draftRequests.current.get(buyerId);
    const draft = previous?.text === text.trim() ? previous : { id: crypto.randomUUID(), text: text.trim(), createdAt: new Date().toISOString() };
    draftRequests.current.set(buyerId, draft);
    await mutate(`message:${buyerId}`, () => repository.addMessage({ ...draft, buyerId, direction: "outgoing", read: true }), (saved) => {
      draftRequests.current.delete(buyerId);
      setState((current) => ({ ...current, messages: [...current.messages, saved] }));
      setToast("Черновик сохранён в CRM");
    });
  }

  async function logout() {
    setSigningOut(true);
    try { await onLogout(); }
    catch (error) { if (active.current) { setStorageError(error instanceof Error ? error.message : "Не удалось выйти."); setSigningOut(false); } }
  }

  const title = NAVIGATION.find((item) => item.id === page)?.label;
  const unread = state.messages.filter((message) => message.direction === "incoming" && !message.read);

  if (!hydrated) return <main className="session-screen"><section className="session-panel"><h1>{storageError ? "Не удалось загрузить CRM" : "Загружаем ваши данные…"}</h1>{storageError && <p className="form-error" role="alert">{storageError}</p>}<div className="session-actions"><button className="button button-primary" disabled={refreshing} onClick={() => void refreshData()}>{refreshing ? "Загрузка…" : "Повторить"}</button><button className="button button-secondary" disabled={signingOut} onClick={() => void logout()}>Выйти</button></div></section></main>;

  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="#" onClick={(event) => { event.preventDefault(); if (!busy && !refreshing) setPage("products"); }} aria-label="Поток — главная"><Logo /><span>поток<span className="brand-period">.</span></span></a>
      <div className="workspace-switch"><span className="workspace-icon"><ShoppingBag size={18} /></span><div><strong>Мой магазин</strong><span>Личное пространство</span></div><ChevronDown size={15} /></div>
      <p className="nav-caption">РАБОЧЕЕ ПРОСТРАНСТВО</p>
      <nav className="navigation" aria-label="Основная навигация">
        {NAVIGATION.map(({ id, label, icon: Icon }) => <button key={id} disabled={busy || refreshing || signingOut} aria-label={label} title={label} className={`nav-item ${page === id ? "active" : ""}`} onClick={() => setPage(id)} aria-current={page === id ? "page" : undefined}><Icon size={19} /><span>{label}</span>{id === "messages" && stats.unreadCount > 0 && <span className="nav-count">{stats.unreadCount}</span>}</button>)}
      </nav>
      <div className="sidebar-bottom">
        <div className="demo-card"><span className="demo-label"><span />ЛИЧНАЯ CRM</span><strong>Ваш магазин, без рутины</strong><p>Товары и покупатели сохраняются в вашем аккаунте.</p><button onClick={() => setHelpOpen(true)}>Как это работает <ArrowUpRight size={15} /></button></div>
        <button className="help-button" onClick={() => setHelpOpen(true)}><CircleHelp size={18} />Помощь и подсказки</button>
        <div className="profile"><span className="avatar">М</span><div><strong>Мой профиль</strong><span className="profile-email" title={user.email}>{user.email}</span></div><span className="online-dot" /></div>
      </div>
    </aside>

    <div className="main-shell">
      <header className="topbar"><div className="breadcrumb"><span>Рабочее пространство</span><ChevronRight size={14} /><strong>{title}</strong></div><div className="topbar-right"><span className="local-badge"><span />Личная CRM</span><div className="notification-wrapper" ref={notificationPanel}><button className={`icon-button notification-button ${notificationsOpen ? "selected" : ""}`} aria-label={`Уведомления: ${stats.unreadCount} непрочитанных`} aria-expanded={notificationsOpen} disabled={busy || signingOut} onClick={() => setNotificationsOpen(!notificationsOpen)}><Bell size={19} />{stats.unreadCount > 0 && <span className="notification-dot" />}</button>{notificationsOpen && <div className="notification-popover"><div className="notification-heading"><strong>Уведомления</strong><span className="count-badge">{unread.length}</span></div>{unread.length ? unread.slice(-5).reverse().map((message) => <button key={message.id} className="notification-entry" onClick={() => openChat(message.buyerId)}><span className="small-avatar"><MessageCircle size={16} /></span><span><strong>{state.buyers.find((buyer) => buyer.id === message.buyerId)?.name ?? "Покупатель"}</strong><span>{message.text}</span></span><span className="blue-dot" /></button>) : <div className="notification-empty"><CheckCheck size={26} /><p>Вы всё прочитали</p></div>}</div>}</div><span className="topbar-divider" /><button className="button button-ghost logout-button" disabled={busy || signingOut} onClick={() => void logout()}>{signingOut ? "Выходим…" : "Выйти"}</button></div></header>

      <main className="main-content" id="main-content"><fieldset className="crm-content" disabled={busy || refreshing || signingOut}>
        <div className="page-heading"><div><div className="heading-eyebrow">ВСЁ ПОД КОНТРОЛЕМ</div><h1>{page === "products" ? "Мои товары" : title}</h1><p>{page === "products" ? "От первого фото до успешной продажи — в одном месте." : page === "messages" ? "Все разговоры с покупателями рядом с вашими товарами." : page === "buyers" ? "Знакомьтесь, договаривайтесь и сохраняйте важное." : "Посмотрите, как ваши товары превращаются в продажи."}</p></div>{page === "products" && <button className="button button-primary add-product-button" onClick={() => setEditor({})}><Plus size={18} />Добавить товар</button>}{page === "analytics" && <span className="pill analytics-demo-label">Данные вашей CRM</span>}</div>

        {storageError && <div className="storage-warning" role="alert">{storageError} <button className="text-button" onClick={() => void refreshData()}>Обновить данные</button></div>}

        {(page === "products" || page === "analytics") && <section className="stats-grid" aria-label="Статистика магазина">
          <StatCard label="Выручка" value={formatMoney(stats.revenue)} icon={<Wallet size={19} />} note={`${stats.soldCount} продано на доске`} color="green" />
          <StatCard label="Отмечено «На Авито»" value={String(stats.activeListings)} icon={<ShoppingBag size={19} />} note="этап указан вручную" color="blue" />
          <StatCard label="Просмотры" value={stats.totalViews.toLocaleString("ru-RU")} icon={<Eye size={19} />} note="синхронизация с Авито не подключена" color="violet" />
          <StatCard label="Новые сообщения" value={String(stats.unreadCount)} icon={<MessageCircle size={19} />} note={stats.unreadCount ? "ждут вашего ответа" : "все сообщения прочитаны"} color="orange" onClick={() => setPage("messages")} />
        </section>}

        {page === "products" && <>
          <section className="create-banner"><div className="banner-spark"><Sparkles size={23} /></div><div className="banner-copy"><div className="banner-title">Одно фото. Готовое объявление.<span className="new-label">ПОПРОБУЙТЕ</span></div><p>Добавьте фото и пару слов о товаре — мы соберём карточку за вас.</p></div><button className="button banner-button" onClick={() => setEditor({})}>Создать объявление<ArrowRight size={16} /></button><div className="banner-art" aria-hidden="true"><div className="art-card art-back" /><div className="art-card art-front"><Package size={25} /><span /><span /></div><span className="art-check"><Check size={14} /></span><Sparkles className="art-spark" size={20} /></div></section>

          <section className="products-section" aria-label="Товары и объявления">
            <div className="board-toolbar"><div className="view-tabs" role="tablist" aria-label="Вид товаров"><button role="tab" aria-selected={view === "board"} className={view === "board" ? "active" : ""} onClick={() => setView("board")}><LayoutGrid size={16} />Воронка товаров<span>{state.products.length}</span></button><button role="tab" aria-selected={view === "list"} className={view === "list" ? "active" : ""} onClick={() => setView("list")}><List size={17} />Все объявления</button></div><button className="text-button refresh-button" disabled={refreshing} onClick={() => void refreshData()}><ArrowDownUp size={14} className={refreshing ? "animate-pulse" : ""} />{refreshing ? "Обновляем…" : "Обновить данные"}</button></div>
            <div className="filters-row"><label className="search-field"><Search size={17} /><input aria-label="Поиск товаров" placeholder="Найти товар…" value={search} onChange={(event) => setSearch(event.target.value)} />{search && <button className="icon-button" aria-label="Очистить поиск" onClick={() => setSearch("")}><X size={14} /></button>}</label><div className="filters-right"><select className="filter-select" aria-label="Категория товаров" value={category} onChange={(event) => setCategory(event.target.value)}><option value="all">Все категории</option>{categories.map((item) => <option key={item}>{item}</option>)}</select><select className="filter-select sort-select" aria-label="Сортировка товаров" value={sort} onChange={(event) => setSort(event.target.value)}><option value="newest">Сначала новые</option><option value="price-asc">Цена: по возрастанию</option><option value="price-desc">Цена: по убыванию</option></select></div></div>
            {view === "board" ? <div className="board-scroll"><div className="kanban-board">{STAGES.map((stage, index) => {
              const products = visibleProducts.filter((product) => product.stage === stage.id);
              return <section key={stage.id} className={`kanban-column stage-${stage.id} ${overStage === stage.id ? "drag-over" : ""}`} data-stage={stage.id} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setOverStage(stage.id); }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setOverStage(null); }} onDrop={(event) => { event.preventDefault(); const id = event.dataTransfer.getData("text/plain") || draggedId; if (id) changeStage(id, stage.id); }}><div className="column-heading"><span className="stage-dot" /><h2>{stage.label}</h2><span className="column-count">{products.length}</span><button className="icon-button column-add" aria-label={`Добавить товар: ${stage.label}`} onClick={() => setEditor({ initialStage: stage.id })}><Plus size={16} /></button></div><div className="column-total">{formatMoney(products.reduce((total, product) => total + product.price, 0))}<span>{String(index + 1).padStart(2, "0")}</span></div><div className="column-cards">{products.map((product) => <ProductCard key={product.id} product={product} messageCount={state.messages.filter((message) => state.buyers.some((buyer) => buyer.id === message.buyerId && buyer.productId === product.id) && message.direction === "incoming").length} dragging={draggedId === product.id} onEdit={() => setEditor({ product })} onMove={(newStage) => changeStage(product.id, newStage)} onDragStart={(event) => { setDraggedId(product.id); event.dataTransfer.setData("text/plain", product.id); event.dataTransfer.effectAllowed = "move"; }} onDragEnd={() => { setDraggedId(null); setOverStage(null); }} />)}{products.length === 0 && <div className="column-empty"><Package size={22} /><span>{search || category !== "all" ? "Товары не найдены" : "Перетащите товар сюда"}</span></div>}<button className="column-add-product" onClick={() => setEditor({ initialStage: stage.id })}><Plus size={15} />Добавить товар</button></div></section>;
            })}</div></div> : <div className="list-view">{visibleProducts.length ? visibleProducts.map((product) => <div className="listing-row" key={product.id}><button className="listing-product" onClick={() => setEditor({ product })}><img src={product.image} alt="" /><span><strong>{product.title}</strong><small>{product.category}</small></span></button><strong>{formatMoney(product.price)}</strong><span className="listing-views"><Eye size={15} />{product.views}</span><select className="select listing-stage" value={product.stage} aria-label={`Этап: ${product.title}`} onChange={(event) => changeStage(product.id, event.target.value as ProductStage)}>{STAGES.map((stage) => <option key={stage.id} value={stage.id}>{stage.label}</option>)}</select><button className="icon-button" onClick={() => setEditor({ product })} aria-label={`Редактировать: ${product.title}`}><MoreHorizontal size={20} /></button></div>) : <div className="empty-state"><Search size={28} /><h3>Таких товаров пока нет</h3><p>Попробуйте другой запрос или категорию.</p><button className="button button-secondary" onClick={() => { setSearch(""); setCategory("all"); }}>Сбросить фильтры</button></div>}</div>}
            <div className="board-footer"><span><GripVertical size={14} />Перетаскивайте карточки или меняйте этап в меню карточки</span><span><span className="small-status-dot" />{busy ? "Сохраняем…" : refreshing ? "Загружаем…" : storageError ? "Проверьте подключение" : "Данные из Supabase"}</span></div>
          </section>
        </>}

        {page === "messages" && <Conversations products={state.products} buyers={state.buyers} messages={state.messages} selectedBuyerId={selectedBuyer} onSelectBuyer={openChat} onSend={saveDraft} />}
        {page === "buyers" && <Buyers products={state.products} buyers={state.buyers} onAdd={(buyer) => saveBuyer(buyer, false)} onUpdate={(buyer) => saveBuyer(buyer, true)} onStatusChange={changeBuyerStatus} onOpenChat={openChat} />}
        {page === "analytics" && <Analytics state={state} />}

        <footer className="page-footer"><span>Поток — больше времени на продажи</span><span>Личная CRM · Авито ещё не подключён</span></footer>
      </fieldset></main>
    </div>
    {editor && <ProductEditor {...editor} onClose={() => setEditor(null)} onSave={saveProduct} />}
    {helpOpen && <HelpDialog onClose={() => setHelpOpen(false)} onCreate={() => { setHelpOpen(false); setEditor({}); }} />}
    {toast && <div className="toast" role="status"><CheckCircle2 size={19} /><span>{toast}</span><button aria-label="Закрыть уведомление" onClick={() => setToast("")}><X size={16} /></button></div>}
  </div>;
}

function StatCard({ label, value, icon, note, color, onClick }: { label: string; value: string; icon: React.ReactNode; note: string; color: string; onClick?: () => void }) {
  const content = <><div className="stat-top"><span>{label}</span><span className={`stat-icon ${color}`}>{icon}</span></div><strong className="stat-value">{value}</strong><div className="stat-note">{color === "green" && <span className="stat-note-dot" />}{note}{onClick && <ArrowUpRight size={14} />}</div></>;
  return onClick ? <button className="stat-card stat-button" onClick={onClick}>{content}</button> : <div className="stat-card">{content}</div>;
}

function ProductCard({ product, messageCount, dragging, onEdit, onMove, onDragStart, onDragEnd }: { product: Product; messageCount: number; dragging: boolean; onEdit: () => void; onMove: (stage: ProductStage) => void; onDragStart: React.DragEventHandler; onDragEnd: React.DragEventHandler }) {
  return <article className={`product-card ${dragging ? "dragging" : ""}`} draggable onDragStart={onDragStart} onDragEnd={onDragEnd} data-product-id={product.id}>
    <button className="product-photo-button" onClick={onEdit} aria-label={`Открыть товар: ${product.title}`}><img src={product.image} alt={product.title} draggable={false} className="product-photo" /><span className={`product-category ${product.stage === "sold" ? "sold" : ""}`}>{product.stage === "sold" ? <><Check size={11} />Продано</> : product.category}</span></button>
    <div className="product-card-body"><div className="product-title-row"><button className="product-title" onClick={onEdit}>{product.title}</button><button className="icon-button product-menu" aria-label={`Редактировать: ${product.title}`} onClick={onEdit}><MoreHorizontal size={17} /></button></div><strong className="product-price">{formatMoney(product.price)}</strong><p className="product-description">{product.description}</p><div className="product-metrics"><span title="Просмотры"><Eye size={13} />{product.views}</span><span title="В избранном"><Heart size={12} />{product.favorites}</span><span className={messageCount ? "has-messages" : ""} title="Входящие сообщения"><MessageCircle size={12} />{messageCount}</span><div className="card-stage-control"><GripVertical size={14} /><select aria-label={`Этап: ${product.title}`} value={product.stage} onChange={(event) => onMove(event.target.value as ProductStage)}>{STAGES.map((stage) => <option key={stage.id} value={stage.id}>{stage.label}</option>)}</select></div></div></div>
  </article>;
}

function Analytics({ state }: { state: DemoState }) {
  const stats = getStats(state);
  const maxViews = Math.max(...state.products.map((product) => product.views), 1);
  const sold = state.products.filter((product) => product.stage === "sold");
  return <div className="analytics-grid"><section className="analytics-panel"><div className="panel-heading"><div><h2>Путь к продаже</h2><p>Текущее распределение товаров по этапам</p></div><span className="pill">{state.products.length} товаров</span></div><div className="funnel-chart">{STAGES.map((stage) => { const count = state.products.filter((product) => product.stage === stage.id).length; return <div className={`funnel-row stage-${stage.id}`} key={stage.id}><div><span className="stage-dot" />{stage.label}<strong>{count}</strong></div><div className="funnel-track"><div style={{ width: `${state.products.length ? count / state.products.length * 100 : 0}%` }} /></div></div>; })}</div><div className="conversion-card"><span>Доля проданных товаров<strong>{stats.conversion}%</strong></span><p>{stats.soldCount} из {state.products.length} товаров прошли весь путь</p></div></section><section className="analytics-panel"><div className="panel-heading"><div><h2>Интерес покупателей</h2><p>Сохранённые просмотры · без синхронизации с Авито</p></div><Eye size={20} /></div><div className="views-chart">{[...state.products].sort((a, b) => b.views - a.views).slice(0, 6).map((product) => <div className="views-row" key={product.id}><img src={product.image} alt="" /><div><span>{product.title}<strong>{product.views}</strong></span><div className="views-track"><div style={{ width: `${product.views / maxViews * 100}%` }} /></div></div></div>)}</div></section><section className="analytics-panel sales-panel"><div className="panel-heading"><div><h2>Завершённые продажи</h2><p>Выручка считается по товарам на этапе «Продан»</p></div><span className="sales-total">{formatMoney(stats.revenue)}</span></div>{sold.length ? sold.map((product) => <div className="sale-row" key={product.id}><img src={product.image} alt="" /><span><strong>{product.title}</strong><small>{product.soldAt ? new Date(product.soldAt).toLocaleDateString("ru-RU", { timeZone: "UTC" }) : "Дата не указана"}</small></span><span className="sale-success"><CheckCircle2 size={14} />Продан</span><strong>{formatMoney(product.price)}</strong></div>) : <div className="empty-state"><ShoppingBag size={28} /><h3>Первая продажа впереди</h3><p>Переместите товар на этап «Продан», чтобы увидеть результат.</p></div>}</section></div>;
}

function HelpDialog({ onClose, onCreate }: { onClose: () => void; onCreate: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  return <dialog ref={dialog} className="modal-panel help-dialog" onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="modal-header"><div><span className="pill">ЗНАКОМСТВО С ПОТОКОМ</span><h2>От идеи до «Продано»</h2></div><button className="icon-button" onClick={onClose} aria-label="Закрыть подсказки"><X size={20} /></button></div><div className="modal-body help-steps">{[{ title: "Добавьте товар", text: "Загрузите фото, напишите пару слов и попробуйте локальную генерацию объявления." }, { title: "Проведите по этапам", text: "Перетаскивайте карточку по доске. На телефоне используйте меню этапов в правом нижнем углу карточки." }, { title: "Познакомьтесь с покупателем", text: "Создайте карточку покупателя, добавьте заметку и сохраните черновик ответа в диалоге." }, { title: "Отметьте продажу", text: "Переместите товар в «Продан»: выручка и аналитика пересчитаются автоматически." }].map((step, index) => <div className="help-step" key={step.title}><span>{index + 1}</span><div><h3>{step.title}</h3><p>{step.text}</p></div></div>)}<div className="demo-explanation">Товары, покупатели и черновики сохраняются в вашем аккаунте Supabase. Для загрузки изменений с другого устройства нажмите «Обновить данные». Статусы покупателей и этапы товаров управляются отдельно. Публикация и отправка сообщений в Авито пока не подключены.</div></div><div className="modal-footer"><button className="button button-primary" onClick={onCreate}><Plus size={16} />Добавить первый товар</button></div></dialog>;
}
