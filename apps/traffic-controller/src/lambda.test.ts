import { describe, expect, test } from "bun:test"

import { handler as apiHandler } from "./api-lambda.ts"
import { handler as reconcileHandler } from "./reconcile-lambda.ts"

describe("traffic-controller lambda scaffolds", () => {
  test("returns validation errors for invalid api payloads", async () => {
    const response = await apiHandler({
      body: JSON.stringify({ command: "ensure_live_webhook_lease" }),
    })

    expect(response.statusCode).toBe(400)
  })

  test("returns scaffold rejection for valid api payloads", async () => {
    const response = await apiHandler({
      body: JSON.stringify({
        command: "get_operation",
        operationId: "op-123",
      }),
    })

    expect(response.statusCode).toBe(501)
  })

  test("rejects invalid reconcile payloads", async () => {
    await expect(reconcileHandler({ command: "unknown" })).rejects.toThrow("Invalid reconcile payload")
  })

  test("keeps reconcile path explicitly unimplemented for now", async () => {
    await expect(reconcileHandler({
      command: "sweep_drift",
      requestId: "sweep-1",
    })).rejects.toThrow("traffic-controller reconcile scaffold only")
  })
})
