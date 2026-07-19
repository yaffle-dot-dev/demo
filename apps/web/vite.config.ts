import { execSync } from "node:child_process"
import tailwindcss from "@tailwindcss/vite"
import { sveltekit } from "@sveltejs/kit/vite"
import { defineConfig } from "vite"

// Get build identifier at build time (works with both jj and git)
function getBuildId(): string {
  // Try jj first - use change ID (more useful in jj workflow)
  try {
    const changeId = execSync("jj log -r @ --no-graph -T 'change_id.short(8)'", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim()
    if (changeId && !changeId.startsWith("0000000")) return changeId
  } catch {
    // jj not available or failed
  }

  // Fall back to git
  try {
    return execSync("git rev-parse --short HEAD", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim()
  } catch {
    return "unknown"
  }
}

function getBuildTime(): string {
  const sourceDateEpoch = Number(process.env.SOURCE_DATE_EPOCH)
  const timestamp = Number.isFinite(sourceDateEpoch) ? sourceDateEpoch * 1000 : Date.now()
  return new Date(timestamp).toISOString()
}

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  ssr: {
    // Bundle better-auth and its dependencies into the SSR output so they don't
    // need to be in node_modules at runtime (adapter-node slim Docker image)
    noExternal: ["better-auth", "@better-auth/**", "better-call"],
  },
  define: {
    __BUILD_SHA__: JSON.stringify(getBuildId()),
    __BUILD_TIME__: JSON.stringify(getBuildTime()),
  },
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
