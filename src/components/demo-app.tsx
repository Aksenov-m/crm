"use client";

import { useState } from "react";
import { CrmApp } from "./crm-app";

export function DemoApp() {
  const [generation, setGeneration] = useState(0);
  return <CrmApp key={generation} demo client={null} user={{ id: "demo", email: "Демонстрационный магазин" }}
    onResetDemo={() => setGeneration((value) => value + 1)}
    onLogout={async () => { window.location.assign("/"); }} />;
}
