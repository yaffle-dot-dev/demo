// @ts-check
import { defineConfig } from "astro/config"
import tailwindcss from "@tailwindcss/vite"

// Site URL from environment (set by CI/CD from Yaffle outputs)
// Falls back to production URL for local development
const siteUrl = process.env.SITE_URL || "https://www.yaffle.dev"

// https://astro.build/config
export default defineConfig({
  site: siteUrl,
  vite: {
    plugins: [tailwindcss()],
    server: {
      host: true,
      allowedHosts: ["yaffle.local"],
    },
  },
})
