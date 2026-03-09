import tailwindcss from "@tailwindcss/vite"
import { sveltekit } from "@sveltejs/kit/vite"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  server: {
    port: 5173,
    host: true,
    allowedHosts: ["yaffle.local"],
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
        // Ensure cookies are forwarded properly
        cookieDomainRewrite: "localhost",
      },
    },
  },
})
