import type { Handle, HandleServerError } from "@sveltejs/kit"

const API_URL = process.env.YAFFLE_PUBLIC_API_URL || process.env.YAFFLE_API_URL

if (!API_URL) {
  throw new Error("YAFFLE_PUBLIC_API_URL must be configured")
}


export const handle: Handle = async ({ event, resolve }) => {
  // Lightweight health check - no SSR rendering, no auth
  if (event.url.pathname === "/app/_/health") {
    return new Response("ok", { status: 200 })
  }

  // Proxy /api requests to the backend API server
  // This includes /api/auth/* for BetterAuth endpoints
  if (event.url.pathname.startsWith("/api")) {
    const targetUrl = `${API_URL}${event.url.pathname}${event.url.search}`
    const headers = new Headers(event.request.headers)
    // Remove host header to avoid issues with the proxy target
    headers.delete("host")

    const response = await fetch(targetUrl, {
      method: event.request.method,
      headers,
      body: event.request.method !== "GET" && event.request.method !== "HEAD"
        ? await event.request.arrayBuffer()
        : undefined,
      // @ts-expect-error duplex is required for streaming bodies
      duplex: "half",
      credentials: "include", // Forward cookies for BetterAuth
    })

    // Clone response headers and ensure cookies are forwarded
    const responseHeaders = new Headers(response.headers)

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    })
  }

  return resolve(event)
}

export const handleError: HandleServerError = ({ error, event }) => {
  console.error(`[SSR error] ${event.request.method} ${event.url.pathname}`, error)
  return {
    message: "Internal Error",
  }
}
