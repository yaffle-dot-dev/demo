import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "./e2e",
  testMatch: "*.smoke.spec.ts",
  fullyParallel: false,
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: "line",
  outputDir: "test-results",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command: "bunx vite dev --host 127.0.0.1 --port 4173",
    cwd: ".",
    port: 4173,
    reuseExistingServer: !process.env.CI,
    env: {
      YAFFLE_PUBLIC_API_URL: "http://127.0.0.1:3000",
      VITE_YAFFLE_SMOKE_AUTH: "true",
      VITE_YAFFLE_SMOKE_AUTH_USER_JSON: JSON.stringify({
        id: "smoke-user",
        email: "smoke@yaffle.dev",
        name: "smoke-user",
        image: null,
      }),
    },
  },
})
