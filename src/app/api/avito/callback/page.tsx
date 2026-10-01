"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, LoaderCircle, XCircle } from "lucide-react";
import { createAvitoRepository } from "@/lib/avito";
import { getSupabaseClient, isSupabaseConfigured } from "@/lib/supabase";

type CallbackState = { kind: "loading" | "success" | "error"; text: string };

export default function AvitoCallbackPage() {
  const [state, setState] = useState<CallbackState>({ kind: "loading", text: "Подтверждаем подключение Авито…" });

  useEffect(() => {
    let active = true;
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code") || "";
    const oauthState = params.get("state") || "";
    const providerError = params.get("error") || "";

    if (!oauthState || (!code && !providerError)) {
      setState({ kind: "error", text: "Авито не вернуло код авторизации. Запустите подключение ещё раз." });
      return () => { active = false; };
    }
    if (!isSupabaseConfigured()) {
      setState({ kind: "error", text: "Supabase не настроен в этой сборке CRM." });
      return () => { active = false; };
    }

    void (async () => {
      try {
        const repository = createAvitoRepository(getSupabaseClient());
        const connected = await repository.completeOAuth(code, oauthState, providerError);
        if (active) setState({ kind: "success", text: "Авито подключено. Возвращаемся в CRM…" });
        const returnOrigin = connected.returnOrigin === "http://127.0.0.1:3000" ? connected.returnOrigin : "https://proaksenov.ru";
        window.setTimeout(() => { if (active) window.location.replace(`${returnOrigin}/?avito=connected&avito_account=${encodeURIComponent(connected.accountKey)}`); }, 500);
      } catch (cause) {
        if (active) setState({ kind: "error", text: cause instanceof Error ? cause.message : "Не удалось завершить подключение Авито." });
      }
    })();
    return () => { active = false; };
  }, []);

  const success = state.kind === "success";
  return <main className="session-screen"><section className="session-panel" aria-live="polite">
    {state.kind === "loading" && <LoaderCircle className="mx-auto animate-spin text-blue-600" size={32} />}
    {success && <CheckCircle2 className="mx-auto text-emerald-600" size={32} />}
    {state.kind === "error" && <XCircle className="mx-auto text-red-600" size={32} />}
    <h1 className="mt-4 text-center">{success ? "Авито подключено" : state.kind === "loading" ? "Подключение Авито" : "Не удалось подключить Авито"}</h1>
    <p className="session-description text-center">{state.text}</p>
    {state.kind === "error" && <a className="button button-primary mt-5" href="/">Вернуться в CRM</a>}
  </section></main>;
}
