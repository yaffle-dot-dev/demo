import { trafficControllerReconcileCommandSchema } from "./contract.ts"

interface ReconcileResult {
  ok: boolean
}

export async function handleReconcileCommand(_body: unknown): Promise<ReconcileResult> {
  throw new Error("traffic-controller reconcile scaffold only")
}

export async function handler(event: unknown): Promise<ReconcileResult> {
  const parsed = trafficControllerReconcileCommandSchema.safeParse(event)
  if (!parsed.success) {
    throw new Error(`Invalid reconcile payload: ${parsed.error.issues[0]?.message ?? "unknown error"}`)
  }

  return handleReconcileCommand(parsed.data)
}
