import type { Metadata } from "next";
import "./globals.css";
import { Analytics } from "./AnalyticsScript";

export const metadata: Metadata = {
  title: "Memora Terminal",
  description:
    "AI-first knowledge-worker terminal — Claude Code × Outlook on Memora's meeting-bot + agentic-runtime backend.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="light">
      <body>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
