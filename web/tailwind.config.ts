import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: { DEFAULT: "#0E1116", 2: "#2A2F37", 3: "#5B626D", 4: "#8C939E" },
        paper: { DEFAULT: "#F6F4EF", 2: "#EDEAE2", 3: "#E2DED3" },
        gold: { DEFAULT: "#E8A317", soft: "#FBF0D5", ink: "#7A5200" },
        ok: { DEFAULT: "#1F7A4D", soft: "#E1F2E8" },
        warn: { DEFAULT: "#9A6100", soft: "#FBEFD6" },
        bad: { DEFAULT: "#B42318", soft: "#FCE7E5" },
      },
      fontFamily: {
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      maxWidth: { page: "72rem" },
    },
  },
  plugins: [],
} satisfies Config;
