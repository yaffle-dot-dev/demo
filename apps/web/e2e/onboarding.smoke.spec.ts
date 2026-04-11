import { expect, test, type Page, type Route } from "@playwright/test"

function fulfillJson(route: Route, body: unknown, status: number = 200): Promise<void> {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  })
}

async function installBrowserSmokeFixtures(page: Page): Promise<void> {
  await page.addInitScript(() => {
    class FakeEventSource {
      static CONNECTING = 0
      static OPEN = 1
      static CLOSED = 2

      readyState = FakeEventSource.OPEN
      url: string
      withCredentials: boolean
      onopen: ((event: Event) => void) | null = null
      onerror: ((event: Event) => void) | null = null
      onmessage: ((event: MessageEvent) => void) | null = null
      #listeners = new Map<string, Set<(event: Event) => void>>()

      constructor(url: string | URL, init?: { withCredentials?: boolean }) {
        this.url = String(url)
        this.withCredentials = Boolean(init?.withCredentials)

        queueMicrotask(() => {
          if (this.readyState === FakeEventSource.CLOSED) return
          const event = new Event("open")
          this.onopen?.(event)
          this.#listeners.get("open")?.forEach((listener) => listener(event))
        })
      }

      addEventListener(type: string, listener: (event: Event) => void): void {
        const existing = this.#listeners.get(type) ?? new Set<(event: Event) => void>()
        existing.add(listener)
        this.#listeners.set(type, existing)
      }

      removeEventListener(type: string, listener: (event: Event) => void): void {
        this.#listeners.get(type)?.delete(listener)
      }

      close(): void {
        this.readyState = FakeEventSource.CLOSED
      }
    }

    Object.defineProperty(window, "EventSource", {
      configurable: true,
      writable: true,
      value: FakeEventSource,
    })
  })
}

test.describe("onboarding browser smoke", () => {
  test("signed-in user with no orgs can create an org and land on repository linking", async ({ page }) => {
    await installBrowserSmokeFixtures(page)

    const createdOrg = {
      id: "org-smoke-browser",
      name: "Smoke Browser Org",
      slug: "smoke-browser-org",
      role: "admin",
      source: "admin_bootstrap",
    }
    let orgCreated = false

    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url())
      const method = route.request().method().toUpperCase()

      if (url.pathname === "/api/orgs" && method === "GET") {
        return fulfillJson(route, { data: orgCreated ? [createdOrg] : [] })
      }

      if (url.pathname === "/api/orgs" && method === "POST") {
        const body = route.request().postDataJSON() as { name?: string; slug?: string }
        expect(body).toEqual({
          name: "Smoke Browser Org",
          slug: "smoke-browser-org",
        })
        orgCreated = true
        return fulfillJson(route, {
          data: {
            id: createdOrg.id,
            name: createdOrg.name,
            slug: createdOrg.slug,
          },
        }, 201)
      }

      if (url.pathname === "/api/me" && method === "GET") {
        return fulfillJson(route, {
          data: {
            githubId: 12345,
            login: "smoke-user",
          },
        })
      }

      if (url.pathname === `/api/orgs/${createdOrg.slug}/repo-mappings` && method === "GET") {
        return fulfillJson(route, { data: [] })
      }

      return fulfillJson(route, {
        error: {
          code: "UNMOCKED_BROWSER_REQUEST",
          message: `${method} ${url.pathname} was not mocked in onboarding.smoke.spec.ts`,
        },
      }, 500)
    })

    await page.goto("/app/")

    await expect(page.getByRole("heading", { name: "Welcome to Yaffle" })).toBeVisible()
    await page.getByRole("link", { name: "Create an org" }).click()

    await expect(page).toHaveURL(/\/app\/new$/)
    await expect(page.getByRole("heading", { name: "Create an organization" })).toBeVisible()

    await page.getByLabel("Name").fill("Smoke Browser Org")
    await expect(page.getByLabel("URL slug")).toHaveValue("smoke-browser-org")

    await page.getByRole("button", { name: "Create organization" }).click()

    await page.waitForURL(/\/app\/smoke-browser-org\/settings\/repositories$/)
    await expect(page.getByRole("heading", { name: "Repositories" })).toBeVisible()
    await expect(page.getByText("No repositories linked yet.")).toBeVisible()
    await expect(page.getByText("Link GitHub repositories to start receiving webhook events and running infrastructure previews.")).toBeVisible()
  })
})
