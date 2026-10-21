import type { Metadata, Viewport } from "next";

import "@fontsource-variable/inter-tight";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/instrument-serif/400.css";
import "@fontsource/instrument-serif/400-italic.css";

import { Crt } from "@/components/Crt";

import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Unlisted · RSVPs without a guest list", template: "%s · Unlisted" },
  description:
    "Refundable shielded-ZEC deposits stop no-shows. Nobody, not even the organiser, ever holds a list of who came.",
  referrer: "no-referrer",
  robots: { index: true, follow: true },
};

export const viewport: Viewport = { themeColor: "#050505", width: "device-width", initialScale: 1, viewportFit: "cover" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="font-sans">
        <Crt>{children}</Crt>
      </body>
    </html>
  );
}
