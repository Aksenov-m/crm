"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownUp, ArrowRight, ArrowUpRight, BarChart3, Bell, Check,
  CheckCheck, CheckCircle2, ChevronDown, ChevronRight, CircleHelp,
  Eye, GripVertical, Heart, LayoutGrid, List, MessageCircle, MoreHorizontal,
  Package, Plus, Search, ShoppingBag, Sparkles, Users, Wallet, X,
} from "lucide-react";
import {
  createInitialState, formatMoney, getStats, moveProduct, parseStoredState,
  STAGES, STORAGE_KEY, type Buyer, type DemoState, type Product, type ProductStage,
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

export function CrmApp() {
  const [state, setState] = useState<DemoState>(createInitialState);
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
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const restored = parseStoredState(raw);
        if (restored) setState(restored);
        else setToast("Сохранённые данные повреждены. Загружены демо-примеры.");
      }
    } catch {
      setStorageError("Браузер запретил сохранение. Изменения доступны до закрытия страницы.");
    }
    setHydrated(true);
    return () => { if (refreshTimer.current) clearTimeout(refreshTimer.current); };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      setStorageError("");
    } catch {
      setStorageError("Не удалось сохранить изменения в браузере. Они останутся доступны до перезагрузки страницы.");
    }
  }, [state, hydrated]);

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

  function openChat(id: string) {
    setSelectedBuyer(id);
    setPage("messages");
    setNotificationsOpen(false);
    setState((current) => ({ ...current, messages: current.messages.map((message) => message.buyerId === id ? { ...message, read: true } : message) }));
  }

  function simulateMessage() {
    const buyer = state.buyers.find((item) => item.id === selectedBuyer) ?? state.buyers[0];
    if (!buyer) { setToast("Сначала добавьте покупателя, чтобы начать диалог."); return; }
    const replies = ["Здравствуйте! Товар ещё в продаже?", "Можно забрать сегодня вечером?", "Спасибо! Подскажите, где можно посмотреть товар?", "Мне подходит. Давайте договоримся о встрече."];
    const count = state.messages.filter((message) => message.buyerId === buyer.id && message.direction === "incoming").length;
    setState((current) => ({ ...current, messages: [...current.messages, {
      id: crypto.randomUUID(), buyerId: buyer.id, text: replies[count % replies.length],
      direction: "incoming", createdAt: new Date().toISOString(), read: page === "messages" && selectedBuyer === buyer.id,
    }] }));
    setToast(`Демо-сообщение: ${buyer.name}`);
  }

  function changeStage(id: string, stage: ProductStage) {
    setState((current) => moveProduct(current, id, stage));
    setDraggedId(null); setOverStage(null);
    setToast(`Товар перемещён: ${STAGES.find((item) => item.id === stage)?.label}`);
  }

  function saveProduct(product: Product) {
    setState((current) => {
      const existing = current.products.find((item) => item.id === product.id);
      if (!existing) return { ...current, products: [{ ...product, ...(product.stage === "sold" ? { soldAt: product.soldAt ?? new Date().toISOString() } : {}) }, ...current.products] };
      const updated = { ...current, products: current.products.map((item) => item.id === product.id ? { ...product, stage: item.stage, soldAt: item.soldAt } : item) };
      return moveProduct(updated, product.id, product.stage);
    });
    setToast(editor?.product ? "Изменения сохранены" : "Объявление добавлено на доску");
    setEditor(null);
  }

  function refreshStatistics() {
    if (refreshing) return;
    setRefreshing(true);
    refreshTimer.current = setTimeout(() => {
      setState((current) => ({ ...current, products: current.products.map((product) => product.stage === "published" ? { ...product, views: product.views + 12, favorites: product.favorites + 1 } : product) }));
      setRefreshing(false);
      setToast("Демо-статистика обновлена: +12 просмотров у активных объявлений");
    }, 650);
  }

  const title = NAVIGATION.find((item) => item.id === page)?.label;
  const unread = state.messages.filter((message) => message.direction === "incoming" && !message.read);

  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="#" onClick={(event) => { event.preventDefault(); setPage("products"); }} aria-label="Поток — главная"><Logo /><span>поток<span className="brand-period">.</span></span></a>
      <div className="workspace-switch"><span className="workspace-icon"><ShoppingBag size={18} /></span><div><strong>Мой магазин</strong><span>Личное пространство</span></div><ChevronDown size={15} /></div>
      <p className="nav-caption">РАБОЧЕЕ ПРОСТРАНСТВО</p>
      <nav className="navigation" aria-label="Основная навигация">
        {NAVIGATION.map(({ id, label, icon: Icon }) => <button key={id} aria-label={label} title={label} className={`nav-item ${page === id ? "active" : ""}`} onClick={() => setPage(id)} aria-current={page === id ? "page" : undefined}><Icon size={19} /><span>{label}</span>{id === "messages" && stats.unreadCount > 0 && <span className="nav-count">{stats.unreadCount}</span>}</button>)}
      </nav>
      <div className="sidebar-bottom">
        <div className="demo-card"><span className="demo-label"><span />ДЕМО-РЕЖИМ</span><strong>Ваш магазин, без рутины</strong><p>Попробуйте весь путь продажи на тестовых данных.</p><button onClick={() => setHelpOpen(true)}>Как это работает <ArrowUpRight size={15} /></button></div>
        <button className="help-button" onClick={() => setHelpOpen(true)}><CircleHelp size={18} />Помощь и подсказки</button>
        <div className="profile"><span className="avatar">М</span><div><strong>Мой профиль</strong><span>Продавец · демо</span></div><span className="online-dot" /></div>
      </div>
    </aside>

    <div className="main-shell">
      <header className="topbar"><div className="breadcrumb"><span>Рабочее пространство</span><ChevronRight size={14} /><strong>{title}</strong></div><div className="topbar-right"><span className="local-badge"><span />Локальное демо</span><div className="notification-wrapper" ref={notificationPanel}><button className={`icon-button notification-button ${notificationsOpen ? "selected" : ""}`} aria-label={`Уведомления: ${stats.unreadCount} непрочитанных`} aria-expanded={notificationsOpen} onClick={() => setNotificationsOpen(!notificationsOpen)}><Bell size={19} />{stats.unreadCount > 0 && <span className="notification-dot" />}</button>{notificationsOpen && <div className="notification-popover"><div className="notification-heading"><strong>Уведомления</strong><span className="count-badge">{unread.length}</span></div>{unread.length ? unread.slice(-5).reverse().map((message) => <button key={message.id} className="notification-entry" onClick={() => openChat(message.buyerId)}><span className="small-avatar"><MessageCircle size={16} /></span><span><strong>{state.buyers.find((buyer) => buyer.id === message.buyerId)?.name ?? "Покупатель"}</strong><span>{message.text}</span></span><span className="blue-dot" /></button>) : <div className="notification-empty"><CheckCheck size={26} /><p>Вы всё прочитали</p></div>}<button className="button button-ghost notification-demo" onClick={simulateMessage}><Plus size={14} />Получить демо-сообщение</button></div>}</div><span className="topbar-divider" /><span className="avatar avatar-small">М</span></div></header>

      <main className="main-content" id="main-content">
        <div className="page-heading"><div><div className="heading-eyebrow">ВСЁ ПОД КОНТРОЛЕМ</div><h1>{page === "products" ? "Мои товары" : title}</h1><p>{page === "products" ? "От первого фото до успешной продажи — в одном месте." : page === "messages" ? "Все разговоры с покупателями рядом с вашими товарами." : page === "buyers" ? "Знакомьтесь, договаривайтесь и сохраняйте важное." : "Посмотрите, как ваши товары превращаются в продажи."}</p></div>{page === "products" && <button className="button button-primary add-product-button" onClick={() => setEditor({})}><Plus size={18} />Добавить товар</button>}{page === "analytics" && <span className="pill analytics-demo-label">Демонстрационные данные</span>}</div>

        {storageError && <div className="storage-warning" role="alert">{storageError}</div>}

        {(page === "products" || page === "analytics") && <section className="stats-grid" aria-label="Статистика магазина">
          <StatCard label="Выручка" value={formatMoney(stats.revenue)} icon={<Wallet size={19} />} note={`${stats.soldCount} продано на доске`} color="green" />
          <StatCard label="На Авито" value={String(stats.activeListings)} icon={<ShoppingBag size={19} />} note="активных демо-объявлений" color="blue" />
          <StatCard label="Просмотры" value={stats.totalViews.toLocaleString("ru-RU")} icon={<Eye size={19} />} note="у всех ваших товаров" color="violet" />
          <StatCard label="Новые сообщения" value={String(stats.unreadCount)} icon={<MessageCircle size={19} />} note={stats.unreadCount ? "ждут вашего ответа" : "все сообщения прочитаны"} color="orange" onClick={() => setPage("messages")} />
        </section>}

        {page === "products" && <>
          <section className="create-banner"><div className="banner-spark"><Sparkles size={23} /></div><div className="banner-copy"><div className="banner-title">Одно фото. Готовое объявление.<span className="new-label">ПОПРОБУЙТЕ</span></div><p>Добавьте фото и пару слов о товаре — мы соберём карточку за вас.</p></div><button className="button banner-button" onClick={() => setEditor({})}>Создать объявление<ArrowRight size={16} /></button><div className="banner-art" aria-hidden="true"><div className="art-card art-back" /><div className="art-card art-front"><Package size={25} /><span /><span /></div><span className="art-check"><Check size={14} /></span><Sparkles className="art-spark" size={20} /></div></section>

          <section className="products-section" aria-label="Товары и объявления">
            <div className="board-toolbar"><div className="view-tabs" role="tablist" aria-label="Вид товаров"><button role="tab" aria-selected={view === "board"} className={view === "board" ? "active" : ""} onClick={() => setView("board")}><LayoutGrid size={16} />Воронка товаров<span>{state.products.length}</span></button><button role="tab" aria-selected={view === "list"} className={view === "list" ? "active" : ""} onClick={() => setView("list")}><List size={17} />Все объявления</button></div><button className="text-button refresh-button" disabled={refreshing} onClick={refreshStatistics}><ArrowDownUp size={14} className={refreshing ? "animate-pulse" : ""} />{refreshing ? "Обновляем…" : "Обновить демо-статистику"}</button></div>
            <div className="filters-row"><label className="search-field"><Search size={17} /><input aria-label="Поиск товаров" placeholder="Найти товар…" value={search} onChange={(event) => setSearch(event.target.value)} />{search && <button className="icon-button" aria-label="Очистить поиск" onClick={() => setSearch("")}><X size={14} /></button>}</label><div className="filters-right"><select className="filter-select" aria-label="Категория товаров" value={category} onChange={(event) => setCategory(event.target.value)}><option value="all">Все категории</option>{categories.map((item) => <option key={item}>{item}</option>)}</select><select className="filter-select sort-select" aria-label="Сортировка товаров" value={sort} onChange={(event) => setSort(event.target.value)}><option value="newest">Сначала новые</option><option value="price-asc">Цена: по возрастанию</option><option value="price-desc">Цена: по убыванию</option></select></div></div>
            {view === "board" ? <div className="board-scroll"><div className="kanban-board">{STAGES.map((stage, index) => {
              const products = visibleProducts.filter((product) => product.stage === stage.id);
              return <section key={stage.id} className={`kanban-column stage-${stage.id} ${overStage === stage.id ? "drag-over" : ""}`} data-stage={stage.id} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setOverStage(stage.id); }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setOverStage(null); }} onDrop={(event) => { event.preventDefault(); const id = event.dataTransfer.getData("text/plain") || draggedId; if (id) changeStage(id, stage.id); }}><div className="column-heading"><span className="stage-dot" /><h2>{stage.label}</h2><span className="column-count">{products.length}</span><button className="icon-button column-add" aria-label={`Добавить товар: ${stage.label}`} onClick={() => setEditor({ initialStage: stage.id })}><Plus size={16} /></button></div><div className="column-total">{formatMoney(products.reduce((total, product) => total + product.price, 0))}<span>{String(index + 1).padStart(2, "0")}</span></div><div className="column-cards">{products.map((product) => <ProductCard key={product.id} product={product} messageCount={state.messages.filter((message) => state.buyers.some((buyer) => buyer.id === message.buyerId && buyer.productId === product.id) && message.direction === "incoming").length} dragging={draggedId === product.id} onEdit={() => setEditor({ product })} onMove={(newStage) => changeStage(product.id, newStage)} onDragStart={(event) => { setDraggedId(product.id); event.dataTransfer.setData("text/plain", product.id); event.dataTransfer.effectAllowed = "move"; }} onDragEnd={() => { setDraggedId(null); setOverStage(null); }} />)}{products.length === 0 && <div className="column-empty"><Package size={22} /><span>{search || category !== "all" ? "Товары не найдены" : "Перетащите товар сюда"}</span></div>}<button className="column-add-product" onClick={() => setEditor({ initialStage: stage.id })}><Plus size={15} />Добавить товар</button></div></section>;
            })}</div></div> : <div className="list-view">{visibleProducts.length ? visibleProducts.map((product) => <div className="listing-row" key={product.id}><button className="listing-product" onClick={() => setEditor({ product })}><img src={product.image} alt="" /><span><strong>{product.title}</strong><small>{product.category}</small></span></button><strong>{formatMoney(product.price)}</strong><span className="listing-views"><Eye size={15} />{product.views}</span><select className="select listing-stage" value={product.stage} aria-label={`Этап: ${product.title}`} onChange={(event) => changeStage(product.id, event.target.value as ProductStage)}>{STAGES.map((stage) => <option key={stage.id} value={stage.id}>{stage.label}</option>)}</select><button className="icon-button" onClick={() => setEditor({ product })} aria-label={`Редактировать: ${product.title}`}><MoreHorizontal size={20} /></button></div>) : <div className="empty-state"><Search size={28} /><h3>Таких товаров пока нет</h3><p>Попробуйте другой запрос или категорию.</p><button className="button button-secondary" onClick={() => { setSearch(""); setCategory("all"); }}>Сбросить фильтры</button></div>}</div>}
            <div className="board-footer"><span><GripVertical size={14} />Перетаскивайте карточки или меняйте этап в меню карточки</span><span><span className="small-status-dot" />{hydrated && !storageError ? "Сохранено в браузере" : "Локальное демо"}</span></div>
          </section>
        </>}

        {page === "messages" && <Conversations products={state.products} buyers={state.buyers} messages={state.messages} selectedBuyerId={selectedBuyer} onSelectBuyer={openChat} onSimulateMessage={simulateMessage} onSend={(buyerId, text) => {
          const trimmed = text.trim(); if (!trimmed) return;
          setState((current) => ({ ...current, buyers: current.buyers.map((buyer) => buyer.id === buyerId && buyer.status === "new" ? { ...buyer, status: "negotiation" } : buyer), messages: [...current.messages, { id: crypto.randomUUID(), buyerId, text: trimmed.slice(0, 4000), direction: "outgoing", createdAt: new Date().toISOString(), read: true }] }));
        }} />}
        {page === "buyers" && <Buyers products={state.products} buyers={state.buyers} onAdd={(buyer) => { setState((current) => ({ ...current, buyers: [...current.buyers, buyer] })); setToast("Покупатель добавлен"); }} onUpdate={(buyer: Buyer) => { setState((current) => ({ ...current, buyers: current.buyers.map((item) => item.id === buyer.id ? buyer : item) })); setToast("Карточка покупателя обновлена"); }} onOpenChat={openChat} />}
        {page === "analytics" && <Analytics state={state} />}

        <footer className="page-footer"><span>Поток — больше времени на продажи</span><span>Демо-прототип · Без подключения к Авито</span></footer>
      </main>
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
  return <div className="analytics-grid"><section className="analytics-panel"><div className="panel-heading"><div><h2>Путь к продаже</h2><p>Текущее распределение товаров по этапам</p></div><span className="pill">{state.products.length} товаров</span></div><div className="funnel-chart">{STAGES.map((stage) => { const count = state.products.filter((product) => product.stage === stage.id).length; return <div className={`funnel-row stage-${stage.id}`} key={stage.id}><div><span className="stage-dot" />{stage.label}<strong>{count}</strong></div><div className="funnel-track"><div style={{ width: `${state.products.length ? count / state.products.length * 100 : 0}%` }} /></div></div>; })}</div><div className="conversion-card"><span>Доля проданных товаров<strong>{stats.conversion}%</strong></span><p>{stats.soldCount} из {state.products.length} товаров прошли весь путь</p></div></section><section className="analytics-panel"><div className="panel-heading"><div><h2>Интерес покупателей</h2><p>Просмотры ваших объявлений · демо</p></div><Eye size={20} /></div><div className="views-chart">{[...state.products].sort((a, b) => b.views - a.views).slice(0, 6).map((product) => <div className="views-row" key={product.id}><img src={product.image} alt="" /><div><span>{product.title}<strong>{product.views}</strong></span><div className="views-track"><div style={{ width: `${product.views / maxViews * 100}%` }} /></div></div></div>)}</div></section><section className="analytics-panel sales-panel"><div className="panel-heading"><div><h2>Завершённые продажи</h2><p>Выручка считается по товарам на этапе «Продан»</p></div><span className="sales-total">{formatMoney(stats.revenue)}</span></div>{sold.length ? sold.map((product) => <div className="sale-row" key={product.id}><img src={product.image} alt="" /><span><strong>{product.title}</strong><small>{product.soldAt ? new Date(product.soldAt).toLocaleDateString("ru-RU", { timeZone: "UTC" }) : "Дата не указана"}</small></span><span className="sale-success"><CheckCircle2 size={14} />Продан</span><strong>{formatMoney(product.price)}</strong></div>) : <div className="empty-state"><ShoppingBag size={28} /><h3>Первая продажа впереди</h3><p>Переместите товар на этап «Продан», чтобы увидеть результат.</p></div>}</section></div>;
}

function HelpDialog({ onClose, onCreate }: { onClose: () => void; onCreate: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  return <dialog ref={dialog} className="modal-panel help-dialog" onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="modal-header"><div><span className="pill">ЗНАКОМСТВО С ПОТОКОМ</span><h2>От идеи до «Продано»</h2></div><button className="icon-button" onClick={onClose} aria-label="Закрыть подсказки"><X size={20} /></button></div><div className="modal-body help-steps">{[{ title: "Добавьте товар", text: "Загрузите фото, напишите пару слов и попробуйте локальную генерацию объявления." }, { title: "Проведите по этапам", text: "Перетаскивайте карточку по доске. На телефоне используйте меню этапов в правом нижнем углу карточки." }, { title: "Познакомьтесь с покупателем", text: "Создайте карточку покупателя. В сообщениях нажмите «Получить сообщение» и ответьте в чате." }, { title: "Отметьте продажу", text: "Переместите товар в «Продан»: выручка и аналитика пересчитаются автоматически." }].map((step, index) => <div className="help-step" key={step.title}><span>{index + 1}</span><div><h3>{step.title}</h3><p>{step.text}</p></div></div>)}<div className="demo-explanation">Это демонстрационный прототип. Объявления и сообщения не отправляются на Авито. Все изменения хранятся только в этом браузере; статусы покупателей и этапы товаров управляются отдельно.</div></div><div className="modal-footer"><button className="button button-primary" onClick={onCreate}><Plus size={16} />Добавить первый товар</button></div></dialog>;
}
