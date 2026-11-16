import type { Config } from "tailwindcss";
const config: Config = {
  darkMode: "class",
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        background: "#09090b",
        surface: "#111114",
        surfaceElevated: "#18181c",
        borderSubtle: "#27272a",
        accent: "#6366f1",
        accentHover: "#4f46e5",
      },
    },
  },
  plugins: [],
};
export default config;
