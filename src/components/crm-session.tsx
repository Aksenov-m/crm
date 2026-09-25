"use client";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { ArrowRight, LoaderCircle, LockKeyhole, Package } from "lucide-react";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseClient, isSupabaseConfigured } from "@/lib/supabase";
import { CrmApp } from "./crm-app";

export function SessionPanel({ children }: { children: ReactNode }) {
  return <main className="session-screen"><section className="session-panel"><div className="session-brand"><span className="brand-mark"><Package size={24} /></span>поток<span className="brand-period">.</span></div>{children}</section><p className="session-caption">Ваши товары, покупатели и продажи — в одном месте.</p></main>;
}

function authError(error: unknown) {
  const code = error && typeof error === "object" && "code" in error ? error.code : "";
  if (code === "invalid_credentials") return "Неверный email или пароль. Проверьте данные и попробуйте ещё раз.";
  if (code === "email_not_confirmed") return "Подтвердите email пользователя в Supabase перед входом.";
  if (code === "over_request_rate_limit") return "Слишком много попыток входа. Попробуйте немного позже.";
  return "Не удалось подключиться. Проверьте интернет и повторите попытку.";
}

export function CrmSession() {
  const [client, setClient] = useState<SupabaseClient | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [configured, setConfigured] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!isSupabaseConfigured()) { setConfigured(false); setLoading(false); return; }
    const supabase = getSupabaseClient();
    setClient(supabase);
    let active = true;
    let authEventReceived = false;
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (!active) return;
      authEventReceived = true;
      setSession(nextSession);
      setLoading(false);
      setPassword("");
    });
    void supabase.auth.getSession().then(({ data, error: sessionError }) => {
      if (!active || authEventReceived) return;
      setSession(data.session);
      setLoading(false);
      if (sessionError) setError(authError(sessionError));
    }).catch(() => { if (active) { setLoading(false); setError(authError(null)); } });
    return () => { active = false; subscription.unsubscribe(); };
  }, []);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!client || busy) return;
    setBusy(true);
    setError("");
    try {
      const { error: loginError } = await client.auth.signInWithPassword({ email: email.trim(), password });
      if (loginError) setError(authError(loginError));
    } catch (loginError) { setError(authError(loginError)); }
    finally { setBusy(false); }
  }

  async function logout() {
    if (!client) return;
    const { error: logoutError } = await client.auth.signOut({ scope: "local" });
    if (logoutError) throw new Error("Не удалось выйти. Проверьте соединение и повторите попытку.");
    setSession(null);
    setPassword("");
    setError("");
  }

  if (loading) return <SessionPanel><p className="session-loading" role="status"><LoaderCircle className="animate-spin" size={20} />Проверяем вход…</p></SessionPanel>;
  if (!configured) return <SessionPanel><h1>Подключение CRM</h1><p className="session-description">Для входа нужно настроить подключение к базе и заново собрать сайт.</p><p className="form-error" role="alert">Не заданы параметры Supabase. Инструкция находится в docs/SUPABASE_SETUP.md проекта.</p></SessionPanel>;
  if (session && client) return <CrmApp key={session.user.id} client={client} user={session.user} onLogout={logout} />;
  return <SessionPanel><span className="session-eyebrow"><LockKeyhole size={14} />ЛИЧНОЕ ПРОСТРАНСТВО</span><h1>Войти в CRM</h1><p className="session-description">Продолжите работу со своими товарами и покупателями.</p><form onSubmit={login} className="session-form"><label className="field" htmlFor="login-email">Email<input id="login-email" className="input" type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.ru" required disabled={busy} /></label><label className="field" htmlFor="login-password">Пароль<input id="login-password" className="input" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required disabled={busy} /></label>{error && <p className="form-error" role="alert">{error}</p>}<button className="button button-primary session-submit" type="submit" disabled={busy}>{busy ? <><LoaderCircle size={17} className="animate-spin" />Входим…</> : <>Войти<ArrowRight size={17} /></>}</button></form><p className="session-note">Вход для пользователей, добавленных владельцем CRM.</p></SessionPanel>;
}
