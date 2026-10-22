import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";

import "@fontsource-variable/inter-tight";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/instrument-serif/400.css";
import "@fontsource/instrument-serif/400-italic.css";

import { Crt } from "@/components/Crt";

import "./globals.css";

export const metadata: Metadata = {
  title: { default: "cashr · RSVPs without a guest list", template: "%s · cashr" },
  description:
    "Refundable shielded-ZEC deposits stop no-shows. Nobody, not even the organiser, ever holds a list of who came.",
  referrer: "no-referrer",
  robots: { index: true, follow: true },
};

// Rendered per request so each page carries its own CSP nonce (src/middleware.ts).
export const dynamic = "force-dynamic";

export const viewport: Viewport = { themeColor: "#050505", width: "device-width", initialScale: 1, viewportFit: "cover" };

// Applies the saved theme before the first paint, so a white-theme visitor never
// sees a dark flash. It carries this response's CSP nonce (src/middleware.ts).
const THEME_SCRIPT =
  "try{var t=JSON.parse(localStorage.getItem('cashr.theme')||'null');" +
  "if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const csp = (await headers()).get("content-security-policy") ?? "";
  const nonce = csp.match(/'nonce-([^']+)'/)?.[1];
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="font-sans">
        <Crt>{children}</Crt>
      </body>
    </html>
  );
}
