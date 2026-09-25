import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Поток — CRM для продавцов Авито",
  description: "Личная CRM: товары, объявления, покупатели и черновики сообщений в одном месте.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ru"><body>{children}</body></html>;
}
