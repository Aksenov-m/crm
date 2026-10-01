"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CheckCircle2, ExternalLink, Link2, LoaderCircle, Plug, RefreshCw } from "lucide-react";
import { createAvitoRepository, type AvitoAccount, type AvitoProfile, type AvitoItemsPage, type AvitoLink, type AvitoItem } from "@/lib/avito";
import { formatMoney, type Product } from "@/lib/crm";

const STATUS: Record<string, string> = { active: "Активно", removed: "Снято", old: "Истёк срок", blocked: "Заблокировано", rejected: "Отклонено", unknown: "Неизвестен" };

export function AvitoConnection({ client, ownerId, products, onProductsChanged, onBusyChange }: { client: SupabaseClient; ownerId: string; products: Product[]; onProductsChanged: () => Promise<void>; onBusyChange: (busy: boolean) => void }) {
  const api = useMemo(() => createAvitoRepository(client), [client]);
  const [accounts, setAccounts] = useState<AvitoAccount[]>([]);
  const [accountKey, setAccountKey] = useState("");
  const [profile, setProfile] = useState<AvitoProfile | null>(null);
  const [page, setPage] = useState<AvitoItemsPage | null>(null);
  const [links, setLinks] = useState<AvitoLink[]>([]);
  const [selection, setSelection] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [linkError, setLinkError] = useState("");
  const [notice, setNotice] = useState("");
  const mounted = useRef(false);
  const generation = useRef(0);
  const saveLock = useRef(false);
  useEffect(() => { onBusyChange(loading || Boolean(saving)); return () => onBusyChange(false); }, [loading, saving, onBusyChange]);

  async function loadAccounts() {
    const job = ++generation.current;
    setLoading(true); setError("");
    try {
      const result = await api.accounts();
      if (!mounted.current || job !== generation.current) return;
      const params = new URLSearchParams(window.location.search);
      const returnedAccountKey = params.get("avito_account") || "";
      const selectedKey = result.some((account) => account.key === returnedAccountKey) ? returnedAccountKey : result[0]?.key ?? "";
      setAccounts(result); setAccountKey(selectedKey);
      if (returnedAccountKey) {
        params.delete("avito_account");
        const query = params.toString();
        window.history.replaceState({}, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
      }
      if (returnedAccountKey && selectedKey) {
        try {
          const connectedProfile = await api.profile(selectedKey);
          if (!mounted.current || job !== generation.current) return;
          setProfile(connectedProfile);
          await load(1, connectedProfile, true, selectedKey);
          if (mounted.current) setNotice("OAuth-доступ Авито подтверждён. Объявления загружены.");
        } catch (cause) {
          if (mounted.current && job === generation.current) setError(message(cause));
        }
      }
    } catch (cause) { if (mounted.current && job === generation.current) setError(message(cause)); }
    finally { if (mounted.current && job === generation.current) setLoading(false); }
  }
  useEffect(() => {
    mounted.current = true;
    void loadAccounts();
    return () => { mounted.current = false; generation.current += 1; };
  }, [api, ownerId]);

  async function importItem(accountId: string, item: AvitoItem, productId: string | null, accountKeyOverride = accountKey) {
    const linkedProductId = await api.connectItem(accountId, item, productId);
    let descriptionError: string | null = null;
    let imageError: string | null = null;
    const existing = products.find((candidate) => candidate.id === linkedProductId);
    const existingImageIsBuiltin = Boolean(existing?.imagePath?.startsWith("/products/"));
    const needsImage = !existing?.imagePath || existingImageIsBuiltin;
    const imageMissing = needsImage && !item.imageUrl;
    if (item.description && (!existing || !existing.description.trim())) {
      try { await api.updateImportedDescription(ownerId, linkedProductId, item.description); }
      catch (cause) { descriptionError = message(cause); }
    }
    if (item.imageUrl && needsImage) {
      try {
        const image = await api.downloadImage(accountKeyOverride, item.imageUrl);
        await api.attachImage(ownerId, linkedProductId, image);
      } catch (cause) { imageError = message(cause); }
    }
    return { productId: linkedProductId, descriptionError, imageError, imageMissing };
  }

  async function verifyAccount() {
    if (!accountKey || saving || loading) return;
    const job = ++generation.current;
    setLoading(true); setError(""); setNotice(""); setLinkError("");
    setPage(null); setLinks([]);
    try {
      const currentProfile = await api.profile(accountKey);
      if (mounted.current && job === generation.current) {
        setProfile(currentProfile);
        setLoading(false);
        await load(1, currentProfile, true, accountKey);
      }
    } catch (cause) {
      if (mounted.current && job === generation.current) { setProfile(null); setError(message(cause)); }
    } finally { if (mounted.current && job === generation.current) setLoading(false); }
  }

  async function startOAuth() {
    if (!accountKey || saving || loading) return;
    setLoading(true); setError(""); setNotice(""); setLinkError("");
    try {
      const result = await api.authorize(accountKey);
      const url = new URL(result.authorizeUrl);
      if (url.protocol !== "https:" || !["avito.ru", "www.avito.ru"].includes(url.hostname)) throw new Error("Авито вернул некорректную ссылку авторизации.");
      window.location.assign(url.href);
    } catch (cause) {
      if (mounted.current) setError(message(cause));
      setLoading(false);
    }
  }

  async function load(targetPage = 1, profileOverride: AvitoProfile | null = profile, allowWhileLoading = false, accountKeyOverride = accountKey) {
    const activeProfile = profileOverride;
    const activeAccountKey = accountKeyOverride;
    if (!activeAccountKey || !activeProfile || saving || (loading && !allowWhileLoading)) return;
    const job = ++generation.current;
    setLoading(true); setError(""); setNotice(""); setLinkError("");
    try {
      const [items, linked] = await Promise.allSettled([api.items(activeAccountKey, targetPage), api.links(ownerId, activeProfile.id)]);
      if (!mounted.current || job !== generation.current) return;
      if (items.status !== "fulfilled") { setPage(null); setError(message(items.reason)); return; }
      setPage(items.value);
      if (linked.status !== "fulfilled") { setLinks([]); setLinkError(message(linked.reason)); return; }
      const currentLinks = linked.value;
      setLinks(currentLinks);

      const imports: PromiseSettledResult<{ productId: string; descriptionError: string | null; imageError: string | null; imageMissing: boolean }>[] = [];
      for (const item of items.value.items) {
        try { imports.push({ status: "fulfilled", value: await importItem(activeProfile.id, item, null, activeAccountKey) }); }
        catch (reason) { imports.push({ status: "rejected", reason }); }
      }
      if (!mounted.current || job !== generation.current) return;
      const failed = imports.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      const importFailures = imports.filter((result): result is PromiseFulfilledResult<{ productId: string; descriptionError: string | null; imageError: string | null; imageMissing: boolean }> => result.status === "fulfilled" && (Boolean(result.value.descriptionError) || Boolean(result.value.imageError))).map((result) => result.value.descriptionError || result.value.imageError as string);
      const missingImages = imports.filter((result): result is PromiseFulfilledResult<{ productId: string; descriptionError: string | null; imageError: string | null; imageMissing: boolean }> => result.status === "fulfilled" && result.value.imageMissing).length;
      if (imports.some((result) => result.status === "fulfilled")) {
        try { await onProductsChanged(); } catch (cause) { setError(message(cause)); }
      }
      if (failed.length) {
        setError(`Не удалось автоматически добавить ${failed.length} объявлений в CRM. ${message(failed[0].reason)}`);
        return;
      }
      if (importFailures.length) setError(`Объявления добавлены, но данные ${importFailures.length} карточек не полностью загрузились. ${importFailures[0]}`);
      else if (missingImages) setError(`Авито не вернуло ссылку на фотографию для ${missingImages} объявлений. Объявления добавлены, но фото загрузить не удалось.`);
      try { setLinks(await api.links(ownerId, activeProfile.id)); } catch (cause) { setLinkError(message(cause)); return; }
      setNotice(items.value.items.length ? `Объявления автоматически добавлены в CRM: ${items.value.items.length}.` : "Объявления Авито синхронизированы.");
    } catch (cause) {
      if (mounted.current && job === generation.current) { setPage(null); setError(message(cause)); }
    } finally { if (mounted.current && job === generation.current) setLoading(false); }
  }

  function chooseAccount(key: string) {
    generation.current += 1;
    setAccountKey(key); setProfile(null); setPage(null); setLinks([]); setSelection({}); setError(""); setLinkError(""); setNotice("");
  }
  async function connect(item: AvitoItem) {
    if (!profile || saveLock.current) return;
    saveLock.current = true; setSaving(item.id); setError(""); setNotice("");
    try {
      const imported = await importItem(profile.id, item, selection[item.id] || null);
      const productId = imported.productId;
      if (!mounted.current) return;
      setLinks((current) => [...current.filter((link) => link.item_id !== item.id), { account_id: profile.id, item_id: item.id, product_id: productId }]);
      setNotice("Объявление связано с товаром CRM.");
      if (imported.descriptionError || imported.imageError) setError(`Объявление связано, но часть данных не загрузилась. ${imported.descriptionError || imported.imageError}`);
      else if (imported.imageMissing) setError("Объявление связано, но Авито не вернуло ссылку на фотографию.");
      await onProductsChanged();
    } catch (cause) { if (mounted.current) setError(message(cause)); }
    finally { saveLock.current = false; if (mounted.current) setSaving(null); }
  }

  return <section aria-label="Подключение Авито" className="space-y-5">
    <div className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
      <div className="flex items-start gap-4"><span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-600"><Plug size={23} /></span><div><h2 className="text-lg font-semibold text-slate-900">Ваш аккаунт Авито</h2><p className="mt-1 text-sm leading-relaxed text-slate-500">Подключите личный аккаунт по сохранённым ключам. После проверки здесь появятся имя и ID аккаунта.</p></div></div>
      <div className="mt-6 flex flex-wrap items-end gap-3"><label className="field w-full min-w-0 sm:w-auto sm:flex-1">Аккаунт Авито<select aria-label="Аккаунт Авито" className="select mt-2" value={accountKey} disabled={loading || Boolean(saving) || !accounts.length} onChange={(event) => chooseAccount(event.target.value)}>{!accounts.length && <option value="">Нет настроенных аккаунтов</option>}{accounts.map((account) => <option key={account.key} value={account.key}>{account.name}</option>)}</select></label><button className="button button-primary" disabled={loading || Boolean(saving)} onClick={() => void (accounts.length ? (profile ? verifyAccount() : startOAuth()) : loadAccounts())}>{loading ? <LoaderCircle size={16} className="animate-spin" /> : <RefreshCw size={16} />}{loading ? "Подключаемся…" : accounts.length ? profile ? "Проверить подключение" : "Подключить через Авито" : "Повторить подключение"}</button></div>
      {profile && <div className="mt-5 flex flex-wrap items-center gap-2 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800"><CheckCircle2 size={17} /><span>Подключён:</span><strong>{profile.name}</strong><span>· ID {profile.id}</span>{profile.profileUrl && <a className="ml-auto inline-flex items-center gap-1 underline" href={profile.profileUrl} target="_blank" rel="noopener noreferrer">Профиль<ExternalLink size={13} /></a>}</div>}
      {profile && <button className="button button-secondary mt-4" disabled={loading || Boolean(saving)} onClick={() => void load(1)}>Обновить объявления</button>}
      <p className="mt-4 text-xs leading-relaxed text-slate-400">Ключи хранятся на сервере. Доступ к подключению есть только у назначенного владельца CRM.</p>
      {error && <p className="form-error mt-4" role="alert">{error}</p>}
      {linkError && <p className="form-error mt-4" role="alert">{linkError} Список Авито доступен для просмотра; привязка временно отключена.</p>}
      {notice && <p className="mt-4 text-sm text-emerald-700" role="status">{notice}</p>}
    </div>
    {page && <div className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6"><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-semibold text-slate-900">Объявления Авито</h2><p className="mt-1 text-xs text-slate-400">Загружено {new Date(page.fetchedAt).toLocaleString("ru-RU")} · страница {page.page}</p></div><span className="pill">{page.items.length} на странице</span></div><p className="mt-4 text-sm leading-relaxed text-slate-500">Объявления автоматически добавляются в CRM после проверки аккаунта. Название, цена, категория и главное фото переносятся; данные уже связанных товаров не перезаписываются.</p>
      <div className="mt-5 space-y-3">{page.items.map((item) => {
        const linked = links.find((link) => link.item_id === item.id);
        const product = products.find((candidate) => candidate.id === linked?.product_id);
        return <article key={item.id} className="rounded-xl border border-slate-200 p-4"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><h3 className="font-semibold break-words text-slate-800">{item.title}</h3><p className="mt-1 text-xs text-slate-400">ID {item.id} · {STATUS[item.status] ?? item.status}{item.category ? ` · ${item.category}` : ""}</p></div>{item.url && <a className="icon-button" href={item.url} target="_blank" rel="noopener noreferrer" aria-label={`Открыть на Авито: ${item.title}`}><ExternalLink size={17} /></a>}</div><p className="mt-3 text-sm font-semibold text-slate-900">{item.price === null ? "Цена не указана" : formatMoney(item.price)}</p>{linked ? <p className="mt-4 flex items-center gap-2 text-sm text-emerald-700"><Link2 size={15} />Связано: {product?.title ?? "товар CRM"}</p> : <div className="mt-4 flex flex-wrap items-center gap-3"><select aria-label={`Товар CRM для ${item.title}`} className="select w-full min-w-0 sm:w-auto sm:flex-1" value={selection[item.id] ?? ""} disabled={loading || Boolean(saving) || Boolean(linkError)} onChange={(event) => setSelection((current) => ({ ...current, [item.id]: event.target.value }))}><option value="">Создать новый товар</option>{products.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.title}</option>)}</select><button className="button button-secondary" disabled={loading || Boolean(saving) || Boolean(linkError)} onClick={() => void connect(item)}>{saving === item.id ? "Сохраняем…" : selection[item.id] ? "Привязать товар" : "Добавить в CRM"}</button></div>}</article>;
      })}{!page.items.length && <p className="py-10 text-center text-sm text-slate-500">На этой странице объявлений нет.</p>}</div>
      <div className="mt-5 flex items-center justify-between gap-3"><button className="button button-secondary" disabled={loading || Boolean(saving) || page.page <= 1} onClick={() => void load(page.page - 1)}>Назад</button><span className="text-xs text-slate-400">Страница {page.page}</span><button className="button button-secondary" disabled={loading || Boolean(saving) || !page.hasMore || page.page >= 1000} onClick={() => void load(page.page + 1)}>Далее</button></div>
    </div>}
  </section>;
}

function message(error: unknown) { return error instanceof Error ? error.message : "Не удалось выполнить действие. Повторите позже."; }
