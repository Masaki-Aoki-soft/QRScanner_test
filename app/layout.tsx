import type { Metadata, Viewport } from "next";

export const metadata: Metadata = { title: "QR読み取りテスト" };
export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif", background: "#111", color: "#fff" }}>
        {children}
      </body>
    </html>
  );
}
