"use client";

import { useEffect } from "react";
import { LoaderCircle } from "lucide-react";
import { backendUrl } from "@/lib/backend";

export default function AvitoCallbackPage(){
  useEffect(()=>{
    const target=new URL(backendUrl("/api/avito/callback"),window.location.href);
    target.search=window.location.search;
    window.location.replace(target.href);
  },[]);
  return <main className="session-screen"><section className="session-panel"><LoaderCircle className="mx-auto animate-spin text-blue-600" size={32}/><h1 className="mt-4 text-center">Подключение Авито</h1><p className="session-description text-center">Передаём подтверждение серверу CRM…</p></section></main>;
}
