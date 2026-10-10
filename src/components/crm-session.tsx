"use client";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { ArrowRight, LoaderCircle, LockKeyhole, Package } from "lucide-react";
import { backendRequest, BackendRequestError, type AppUser } from "@/lib/backend";
import { CrmApp } from "./crm-app";

export function SessionPanel({children}:{children:ReactNode}){
  return <main className="session-screen"><section className="session-panel"><div className="session-brand"><span className="brand-mark"><Package size={24}/></span>ПроЛот<span className="brand-period">.</span></div>{children}</section><a href="/demo/" className="button button-secondary mt-4">Попробовать демо без входа</a><p className="session-caption">Ваши товары, покупатели и продажи — в одном месте.</p></main>;
}
function authError(error:unknown){
  if(error instanceof BackendRequestError){
    if(error.code==="invalid_credentials")return "Неверный email или пароль. Проверьте данные и попробуйте ещё раз.";
    if(error.status===429)return "Слишком много попыток входа. Попробуйте немного позже.";
    return error.message;
  }
  return "Не удалось подключиться к серверу CRM. Проверьте адрес API и повторите попытку.";
}

export function CrmSession(){
  const [user,setUser]=useState<AppUser|null>(null);
  const [loading,setLoading]=useState(true);
  const [email,setEmail]=useState("");
  const [password,setPassword]=useState("");
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");

  useEffect(()=>{
    let active=true;
    void backendRequest<{user:AppUser}>("/api/auth/session").then(result=>{if(active)setUser(result.user)}).catch(cause=>{if(!active)return;if(!(cause instanceof BackendRequestError&&cause.status===401))setError(authError(cause))}).finally(()=>{if(active)setLoading(false)});
    return()=>{active=false};
  },[]);

  async function login(event:FormEvent<HTMLFormElement>){
    event.preventDefault();if(busy)return;setBusy(true);setError("");
    try{const result=await backendRequest<{user:AppUser}>("/api/auth/login",{method:"POST",body:JSON.stringify({email:email.trim(),password})});setUser(result.user);setPassword("")}
    catch(cause){setError(authError(cause))}finally{setBusy(false)}
  }
  async function logout(){
    try{await backendRequest("/api/auth/logout",{method:"POST",body:JSON.stringify({})})}
    catch{throw new Error("Не удалось выйти. Проверьте подключение к серверу и повторите попытку.")}
    setUser(null);setPassword("");setError("");
  }

  if(loading)return <SessionPanel><p className="session-loading" role="status"><LoaderCircle className="animate-spin" size={20}/>Проверяем вход…</p></SessionPanel>;
  if(user)return <CrmApp key={user.id} user={user} onLogout={logout}/>;
  return <SessionPanel><span className="session-eyebrow"><LockKeyhole size={14}/>ЛИЧНОЕ ПРОСТРАНСТВО</span><h1>Войти в CRM</h1><p className="session-description">Продолжите работу со своими товарами и покупателями.</p><form onSubmit={login} className="session-form"><label className="field" htmlFor="login-email">Email<input id="login-email" className="input" type="email" autoComplete="username" value={email} onChange={event=>setEmail(event.target.value)} placeholder="you@example.ru" required disabled={busy}/></label><label className="field" htmlFor="login-password">Пароль<input id="login-password" className="input" type="password" autoComplete="current-password" value={password} onChange={event=>setPassword(event.target.value)} required disabled={busy}/></label>{error&&<p className="form-error" role="alert">{error}</p>}<button className="button button-primary session-submit" type="submit" disabled={busy}>{busy?<><LoaderCircle size={17} className="animate-spin"/>Входим…</>:<>Войти<ArrowRight size={17}/></>}</button></form><p className="session-note">Вход для пользователей, созданных владельцем CRM.</p></SessionPanel>;
}
