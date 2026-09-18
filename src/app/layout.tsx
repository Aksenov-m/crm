import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Поток — CRM для продавцов Авито",
  description: "От первого фото до продажи. Демонстрационная CRM: товары, объявления, покупатели и сообщения в одном месте.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ru"><body>{children}</body></html>;
}
