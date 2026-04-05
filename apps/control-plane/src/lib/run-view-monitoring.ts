import { randomUUID } from "node:crypto"

import { z } from "zod"

export const runViewCorrelationQueryFields = {
  run_view_session_id: z.string().uuid().optional(),
  page_view_id: z.string().uuid().optional(),
}

export interface RunViewCorrelation {
  runViewSessionId: string | null
  pageViewId: string | null
}

export interface StreamContext {
  streamType: "environment" | "pr" | "env" | "run_log"
  streamId: string
  runViewSessionId: string | null
  pageViewId: string | null
}

export interface StreamPayloadMeta {
  streamType: StreamContext["streamType"]
  streamId: string
  runViewSessionId: string | null
  pageViewId: string | null
  sourceEventType: string
  sourceEventAt: string
  sentAt: string
}

export function createStreamContext(
  streamType: StreamContext["streamType"],
  correlation: RunViewCorrelation,
): StreamContext {
  return {
    streamType,
    streamId: randomUUID(),
    runViewSessionId: correlation.runViewSessionId,
    pageViewId: correlation.pageViewId,
  }
}

export function buildStreamPayloadMeta(params: {
  context: StreamContext
  sourceEventType: string
  sourceEventAt: string
  sentAt?: string
}): StreamPayloadMeta {
  return {
    streamType: params.context.streamType,
    streamId: params.context.streamId,
    runViewSessionId: params.context.runViewSessionId,
    pageViewId: params.context.pageViewId,
    sourceEventType: params.sourceEventType,
    sourceEventAt: params.sourceEventAt,
    sentAt: params.sentAt ?? new Date().toISOString(),
  }
}

export function parseRunViewCorrelation(params: {
  run_view_session_id?: string
  page_view_id?: string
}): RunViewCorrelation {
  return {
    runViewSessionId: params.run_view_session_id ?? null,
    pageViewId: params.page_view_id ?? null,
  }
}
