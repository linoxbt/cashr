import type { Metadata, Viewport } from "next";

import { SiteFooter, SiteHeader } from "@/components/Shell";
import { SimBanner } from "@/components/ui";

import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Unlisted · RSVPs without a guest list", template: "%s · Unlisted" },
  description:
    "Refundable shielded-ZEC deposits stop no-shows. Nobody, not even the organiser, ever holds a list of who came.",
  referrer: "no-referrer",
  robots: { index: true, follow: true },
};

export const viewport: Viewport = { themeColor: "#F6F4EF", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans">
        <SimBanner />
        <SiteHeader />
        <main>{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}
