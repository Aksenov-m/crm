"use client";

import { useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { Check, ImagePlus, LoaderCircle, Sparkles, Upload, X } from "lucide-react";
import { generateListing, STAGES, type Product, type ProductStage } from "@/lib/crm";
import { getCrmErrorMessage } from "@/lib/crm-repository";

type ProductEditorProps = {
  product?: Product;
  initialStage?: ProductStage;
  onClose: () => void;
  onSave: (product: Product) => Promise<void>;
};

const CATEGORIES = ["Мебель", "Электроника", "Бытовая техника", "Одежда и аксессуары", "Для дома", "Спорт и отдых", "Другое"];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export function ProductEditor({ product, initialStage, onClose, onSave }: ProductEditorProps) {
  const formId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const readerRef = useRef<FileReader | null>(null);
  const imageElementRef = useRef<HTMLImageElement | null>(null);
  const imageJobRef = useRef(0);
  const generationTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [image, setImage] = useState(product?.image ?? "");
  const [brief, setBrief] = useState(product?.description ?? "");
  const [price, setPrice] = useState(product ? String(product.price) : "");
  const [category, setCategory] = useState(product?.category ?? "");
  const [stage, setStage] = useState<ProductStage>(product?.stage ?? initialStage ?? STAGES[0].id);
  const [title, setTitle] = useState(product?.title ?? "");
  const [description, setDescription] = useState(product?.description ?? "");
  const [generated, setGenerated] = useState(Boolean(product));
  const [generating, setGenerating] = useState(false);
  const [imageLoading, setImageLoading] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const saveInProgress = useRef(false);
  const newId = useRef<string | null>(null);
  const busy = generating || imageLoading || saving;

  function close() { if (!saveInProgress.current) onClose(); }

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement;
    dialog?.showModal();
    descriptionRef.current?.focus();

    return () => {
      if (generationTimer.current) clearTimeout(generationTimer.current);
      imageJobRef.current += 1;
      readerRef.current?.abort();
      if (imageElementRef.current) {
        imageElementRef.current.onload = null;
        imageElementRef.current.onerror = null;
        imageElementRef.current.src = "";
      }
      dialog?.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);

  function readImage(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setError("");
    const job = ++imageJobRef.current;
    readerRef.current?.abort();
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      setImageLoading(false);
      setError("Выберите фотографию в формате JPEG, PNG или WebP.");
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setImageLoading(false);
      setError("Фотография слишком большая. Выберите файл размером до 5 МБ.");
      return;
    }
    setImageLoading(true);
    const reader = new FileReader();
    readerRef.current = reader;
    const fail = () => {
      if (imageJobRef.current !== job) return;
      setImageLoading(false);
      setError("Не удалось открыть фотографию. Попробуйте другой файл.");
    };
    reader.onerror = fail;
    reader.onload = () => {
      if (imageJobRef.current !== job || typeof reader.result !== "string") return;
      const sourceImage = new Image();
      imageElementRef.current = sourceImage;
      sourceImage.onerror = fail;
      sourceImage.onload = () => {
        if (imageJobRef.current !== job) return;
        try {
          if (!sourceImage.naturalWidth || !sourceImage.naturalHeight) throw new Error("Empty image");
          const scale = Math.min(1, 1200 / Math.max(sourceImage.naturalWidth, sourceImage.naturalHeight));
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(sourceImage.naturalWidth * scale));
          canvas.height = Math.max(1, Math.round(sourceImage.naturalHeight * scale));
          const context = canvas.getContext("2d");
          if (!context) throw new Error("Canvas unavailable");
          context.fillStyle = "#ffffff";
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.drawImage(sourceImage, 0, 0, canvas.width, canvas.height);
          const photo = canvas.toDataURL("image/jpeg", 0.82);
          if (!photo.startsWith("data:image/jpeg;base64,")) throw new Error("Image encoding failed");
          setImage(photo);
          setImageLoading(false);
        } catch {
          fail();
        }
      };
      sourceImage.src = reader.result;
    };
    try {
      reader.readAsDataURL(file);
    } catch {
      fail();
    }
  }

  function validateBase() {
    if (!image) return "Добавьте фотографию товара.";
    if (!brief.trim()) return "Кратко опишите товар: что продаёте и в каком он состоянии.";
    if (!price.trim() || !Number.isFinite(Number(price)) || Number(price) <= 0) return "Укажите цену больше нуля.";
    if (Number(price) >= 1e12) return "Цена должна быть меньше 1 000 000 000 000 ₽.";
    if (!category) return "Выберите категорию товара.";
    return "";
  }

  function generate() {
    if (busy) return;
    const validationError = validateBase();
    setError(validationError);
    if (validationError) return;
    setGenerating(true);
    generationTimer.current = setTimeout(() => {
      try {
        const result = generateListing({ description: brief.trim(), price: Number(price), category });
        setTitle(result.title);
        setDescription(result.description);
        setGenerated(true);
      } catch {
        setError("Не удалось подготовить объявление. Проверьте описание и цену и попробуйте снова.");
      } finally {
        setGenerating(false);
        generationTimer.current = null;
      }
    }, 650);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || saveInProgress.current) return;
    if (!generated) {
      generate();
      return;
    }
    const validationError = validateBase();
    if (validationError) {
      setError(validationError);
      return;
    }
    if (!title.trim() || !description.trim()) {
      setError("Заполните заголовок и описание объявления.");
      return;
    }
    setError("");
    const now = new Date().toISOString();
    newId.current ??= crypto.randomUUID();
    saveInProgress.current = true;
    setSaving(true);
    try { await onSave({
      id: product?.id ?? newId.current,
      title: title.trim(),
      description: description.trim(),
      price: Number(price),
      image,
      imagePath: image === product?.image ? product.imagePath : undefined,
      stage,
      category,
      views: product?.views ?? 0,
      favorites: product?.favorites ?? 0,
      createdAt: product?.createdAt ?? now,
      soldAt: stage === "sold" ? product?.soldAt ?? now : undefined,
    }); } catch (cause) { setError(getCrmErrorMessage(cause)); }
    finally { saveInProgress.current = false; setSaving(false); }
  }

  function useExample() {
    if (busy) return;
    setImage("/products/chair.jpg");
    setBrief("Кресло из светлого дерева с мягким сиденьем. Пользовались полгода, состояние отличное, без пятен и повреждений. Самовывоз.");
    setPrice("8500");
    setCategory("Мебель");
    setGenerated(false);
    setError("");
    descriptionRef.current?.focus();
  }

  const categoryOptions = category && !CATEGORIES.includes(category) ? [category, ...CATEGORIES] : CATEGORIES;

  return (
    <dialog
      ref={dialogRef}
      className="modal-panel product-editor"
      aria-labelledby={`${formId}-heading`}
      aria-describedby={`${formId}-intro`}
      onCancel={(event) => { event.preventDefault(); close(); }}
      onClick={(event) => { if (event.target === event.currentTarget) close(); }}
    >
      <div className="modal-header">
        <div>
          <h2 id={`${formId}-heading`}>{product ? "Карточка товара" : "Новое объявление"}</h2>
          <p id={`${formId}-intro`} className="muted">
            {product ? "Обновите информацию и выберите этап продажи." : "Одно фото, несколько слов — и объявление готово."}
          </p>
        </div>
        <button type="button" className="icon-button" aria-label="Закрыть карточку" disabled={saving} onClick={close}><X size={20} /></button>
      </div>

      <form id={formId} className="editor-form" onSubmit={save} noValidate>
        <div className="modal-body">
          <div className="editor-grid">
            <div>
              <label className="field" htmlFor={`${formId}-photo`}>Фото товара <span aria-hidden="true">*</span></label>
              <input
                ref={fileRef}
                id={`${formId}-photo`}
                className="photo-input sr-only"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={readImage}
                disabled={busy}
                tabIndex={-1}
                aria-describedby={`${formId}-photo-hint`}
              />
              <button
                type="button"
                className={`photo-upload${image ? " has-image" : ""}`}
                disabled={busy}
                onClick={() => fileRef.current?.click()}
                aria-label={image ? "Заменить фотографию товара" : "Загрузить фотографию товара"}
                aria-describedby={`${formId}-photo-hint`}
              >
                {image ? (
                  <>
                    {/* A new photo is previewed locally before uploading on save. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img className="photo-preview" src={image} alt="Фотография товара" />
                    <span className="photo-action"><Upload size={15} /> Заменить фото</span>
                  </>
                ) : (
                  <span className="photo-placeholder">
                    {imageLoading ? <LoaderCircle size={30} className="animate-spin" /> : <ImagePlus size={30} />}
                    <strong>{imageLoading ? "Готовим фотографию…" : "Добавьте фотографию"}</strong>
                    <span>Нажмите, чтобы выбрать файл</span>
                  </span>
                )}
              </button>
              <p id={`${formId}-photo-hint`} className="photo-hint muted">JPEG, PNG или WebP · до 5 МБ</p>
              {imageLoading && image && <p className="muted" role="status">Готовим новую фотографию…</p>}
              {!product && !generated && (
                <button type="button" className="button button-ghost" onClick={useExample} disabled={busy}>Попробовать на примере</button>
              )}
            </div>

            <div className="editor-fields">
              <label className="field" htmlFor={`${formId}-brief`}>
                {product ? "Исходное описание" : "Расскажите о товаре"} <span aria-hidden="true">*</span>
                <textarea
                  ref={descriptionRef}
                  id={`${formId}-brief`}
                  className="textarea"
                  rows={4}
                  maxLength={3000}
                  placeholder="Например: деревянное кресло, почти новое, без царапин. Продаю из-за переезда."
                  value={brief}
                  onChange={(event) => { setBrief(event.target.value); if (!product) setGenerated(false); }}
                  disabled={busy}
                  required
                />
              </label>
              <div className="editor-field-row">
                <label className="field" htmlFor={`${formId}-price`}>Цена, ₽ <span aria-hidden="true">*</span>
                  <input id={`${formId}-price`} className="input" type="number" inputMode="decimal" min="0.01" step="0.01" placeholder="0" value={price} onChange={(event) => { setPrice(event.target.value); if (!product) setGenerated(false); }} disabled={busy} required />
                </label>
                <label className="field" htmlFor={`${formId}-category`}>Категория <span aria-hidden="true">*</span>
                  <select id={`${formId}-category`} className="select" value={category} onChange={(event) => { setCategory(event.target.value); if (!product) setGenerated(false); }} disabled={busy} required>
                    <option value="">Выберите категорию</option>
                    {categoryOptions.map((option) => <option key={option} value={option}>{option}</option>)}
                  </select>
                </label>
              </div>
              {product && (
                <label className="field" htmlFor={`${formId}-stage`}>Этап продажи
                  <select id={`${formId}-stage`} className="select" value={stage} onChange={(event) => setStage(event.target.value as ProductStage)} disabled={busy}>
                    {STAGES.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
                  </select>
                </label>
              )}
              <div className="generation-note"><Sparkles size={16} /><span>Текст собирается по шаблону из вашего описания. Проверьте и дополните результат.</span></div>
              {generated && (
                <button type="button" className="button button-secondary" onClick={generate} disabled={busy}>
                  {generating ? <LoaderCircle size={17} className="animate-spin" /> : <Sparkles size={17} />}
                  {generating ? "Готовим объявление…" : "Сгенерировать заново"}
                </button>
              )}
            </div>
          </div>

          {generated && (
            <section className="generated-listing" aria-labelledby={`${formId}-result`}>
              <div className="generated-listing-heading"><Check size={18} /><h3 id={`${formId}-result`}>{product ? "Текст объявления" : "Объявление готово"}</h3><span className="muted">Можно отредактировать</span></div>
              <label className="field" htmlFor={`${formId}-title`}>Заголовок <span aria-hidden="true">*</span>
                <input id={`${formId}-title`} className="input" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} disabled={busy} required />
              </label>
              <label className="field" htmlFor={`${formId}-description`}>Описание объявления <span aria-hidden="true">*</span>
                <textarea id={`${formId}-description`} className="textarea" rows={6} value={description} onChange={(event) => setDescription(event.target.value)} maxLength={5000} disabled={busy} required />
              </label>
            </section>
          )}
          <div aria-live="polite" className="sr-only">{generating ? "Создаём объявление" : generated ? "Текст объявления доступен для редактирования" : ""}</div>
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>

        <div className="modal-footer">
          <span className="muted">Сохранение в CRM · без публикации на Авито</span>
          <div className="flex items-center gap-2">
            <button type="button" className="button button-secondary" disabled={saving} onClick={close}>Отмена</button>
            <button type="submit" className="button button-primary" disabled={busy}>
              {generating ? <LoaderCircle size={17} className="animate-spin" /> : generated ? <Check size={17} /> : <Sparkles size={17} />}
              {saving ? "Сохраняем…" : generating ? "Готовим объявление…" : product ? "Сохранить изменения" : generated ? "Добавить на доску" : "Сгенерировать объявление"}
            </button>
          </div>
        </div>
      </form>
    </dialog>
  );
}
