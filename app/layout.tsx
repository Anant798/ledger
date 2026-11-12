import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ledger — Personal Financial Journal",
  description: "A clear, considered record of your financial life.",
  icons: {
    icon: "https://raw.githubusercontent.com/Anant798/ledger/master/Ledger%20Icon.png",
    shortcut: "https://raw.githubusercontent.com/Anant798/ledger/master/Ledger%20Icon.png",
    apple: "https://raw.githubusercontent.com/Anant798/ledger/master/Ledger%20Icon.png",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
