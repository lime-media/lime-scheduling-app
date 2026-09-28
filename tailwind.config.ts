import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    // Shared colour classes live in lib/statusColors.ts (and lib/ may hold
    // more). Tailwind only emits CSS for class names in scanned files, so
    // without this, colours used only in lib/ (AT&T soft-hold blue,
    // maintenance orange) render as no colour at all.
    "./lib/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
      },
    },
  },
  plugins: [],
};
export default config;
