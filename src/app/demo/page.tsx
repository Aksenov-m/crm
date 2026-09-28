import type { Metadata } from "next";
import { DemoApp } from "@/components/demo-app";

export const metadata: Metadata = { title: "Демо — ПроЛот" };

export default function DemoPage() {
  return <DemoApp />;
}
