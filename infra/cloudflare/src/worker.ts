interface Env {
  DEMO_STATE: KVNamespace
  DEMO_MESSAGE: string
  YAFFLE_ENVIRONMENT: string
  YAFFLE_ENVIRONMENT_KIND: string
}

function json(value: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers)
  headers.set("content-type", "application/json; charset=utf-8")
  headers.set("cache-control", "no-store")
  return new Response(JSON.stringify(value, null, 2), { ...init, headers })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (request.method !== "GET") {
      return json({ error: "method_not_allowed" }, { status: 405, headers: { allow: "GET" } })
    }
    if (url.pathname === "/health") {
      return json({ ok: true, environment: env.YAFFLE_ENVIRONMENT })
    }
    if (url.pathname !== "/") {
      return json({ error: "not_found" }, { status: 404 })
    }

    const storedMessage = await env.DEMO_STATE.get("message")
    return json({
      service: "yaffle-cloudflare-demo",
      environment: env.YAFFLE_ENVIRONMENT,
      environmentKind: env.YAFFLE_ENVIRONMENT_KIND,
      message: storedMessage ?? env.DEMO_MESSAGE,
    })
  },
}
