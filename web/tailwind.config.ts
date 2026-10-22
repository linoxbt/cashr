import type { Config } from "tailwindcss";

// CRT palette. Token names are kept from the original theme so pages read the
// same: `ink` is the foreground, `paper` and `screen` the surfaces. Each token is
// a CSS variable (globals.css) with a dark and a white theme value, written as
// "r g b" so opacity modifiers like `text-ink/50` keep working.
const v = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: { DEFAULT: v("ink"), 2: v("ink-2"), 3: v("ink-3"), 4: v("ink-4") },
        paper: { DEFAULT: v("paper"), 2: v("paper-2"), 3: v("paper-3") },
        screen: { DEFAULT: v("screen"), 2: v("screen-2"), 3: v("screen-3"), bezel: v("bezel-tone") },
        // Wells sit under inputs and panels: darker than the screen in the dark theme, white in the white one.
        well: v("well"),
        gold: { DEFAULT: v("gold"), soft: v("gold-soft"), ink: v("gold-ink"), on: v("on-gold") },
        ok: { DEFAULT: v("ok"), soft: v("ok-soft") },
        warn: { DEFAULT: v("warn"), soft: v("warn-soft") },
        bad: { DEFAULT: v("bad"), soft: v("bad-soft") },
        tape: { red: "#E0262B", gold: "#F4B728", violet: "#7C5CFF", green: "#3DD68C", blue: "#3B6CFF", bone: "#E8E1D0" },
      },
      fontFamily: {
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "SFMono-Regular", "monospace"],
        display: ["var(--font-display)", "ui-serif", "Georgia", "serif"],
      },
      maxWidth: { page: "72rem" },
    },
  },
  plugins: [],
} satisfies Config;
