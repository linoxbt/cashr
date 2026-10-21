import type { Config } from "tailwindcss";

// CRT palette. Token names are kept from the original theme so pages read the
// same: `ink` is the foreground (phosphor cream), `paper` the screen.
export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: { DEFAULT: "#ECE9E1", 2: "#CFCBC2", 3: "#9A968E", 4: "#6B6862" },
        paper: { DEFAULT: "#111111", 2: "#191919", 3: "#222222" },
        screen: { DEFAULT: "#111111", 2: "#161616", 3: "#1D1D1D", bezel: "#050505" },
        gold: { DEFAULT: "#F4B728", soft: "#2A2312", ink: "#F4C95A" },
        ok: { DEFAULT: "#2FA36B", soft: "#12251B" },
        warn: { DEFAULT: "#D99A1E", soft: "#2A2112" },
        bad: { DEFAULT: "#E5484D", soft: "#2C1416" },
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
