import {
  trafficControllerApiCommandSchema,
  type TrafficControllerApiResponse,
} from "./contract.ts"

interface LambdaHttpEvent {
  body?: string | null
}

interface LambdaHttpResponse {
  statusCode: number
  headers: Record<string, string>
  body: string
}

export async function handleApiCommand(_body: unknown): Promise<TrafficControllerApiResponse> {
  return {
    status: "rejected",
    code: "NOT_IMPLEMENTED",
    message: "traffic-controller scaffold only",
  }
}

export async function handler(event: LambdaHttpEvent): Promise<LambdaHttpResponse> {
  let body: unknown

  try {
    body = JSON.parse(event.body ?? "{}")
  } catch {
    return {
      statusCode: 400,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        error: {
          code: "INVALID_JSON",
          message: "Request body must be valid JSON",
        },
      }),
    }
  }

  const parsed = trafficControllerApiCommandSchema.safeParse(body)
  if (!parsed.success) {
    return {
      statusCode: 400,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid traffic-controller command payload",
          details: parsed.error.issues,
        },
      }),
    }
  }

  const result = await handleApiCommand(parsed.data)
  const statusCode = result.status === "rejected" ? 501 : result.status === "operation" ? 200 : 202

  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ data: result }),
  }
}
