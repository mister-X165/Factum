import type { Metadata } from "next";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

export const metadata: Metadata = {
  title: "Фактум — Медицинский фактчекер",
  description:
    "Локальная система интеллектуального фактчекинга медицинской информации: evidence-based проверка достоверности медицинских публикаций.",
  keywords: [
    "Фактум",
    "фактчекинг",
    "медицина",
    "evidence-based",
    "проверка источников",
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru" suppressHydrationWarning className="dark">
      <body className="antialiased bg-background text-foreground">
        {children}
        <Toaster />
      </body>
    </html>
  );
}
