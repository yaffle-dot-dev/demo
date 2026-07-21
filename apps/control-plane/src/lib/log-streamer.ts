/**
 * CloudWatch Log Streamer
 *
 * Streams logs from runner ECS tasks to clients via SSE or WebSocket.
 * Uses CloudWatch Logs GetLogEvents API with polling.
 *
 * Flow:
 *   1. Client connects to /api/runs/:id/logs
 *   2. Server looks up the ECS task ARN for the run
 *   3. Server constructs CloudWatch log stream name from task ARN
 *   4. Server polls GetLogEvents and streams to client
 *   5. When task completes (or client disconnects), streaming stops
 */

import {
  CloudWatchLogsClient,
  GetLogEventsCommand,
  type GetLogEventsCommandOutput,
} from "@aws-sdk/client-cloudwatch-logs"

import { getAwsClientConfig } from "./aws-client-config.ts"
import { logger } from "./telemetry.ts"

/**
 * Configuration for the log streamer.
 */
export interface LogStreamerConfig {
  /** CloudWatch log group name */
  logGroupName: string
  /** AWS region */
  region: string
  /** Polling interval in milliseconds */
  pollIntervalMs?: number
}

/**
 * A streaming log reader that polls CloudWatch Logs.
 */
export class LogStreamer {
  private readonly client: CloudWatchLogsClient
  private readonly logGroupName: string
  private readonly pollIntervalMs: number

  constructor(config: LogStreamerConfig) {
    this.client = new CloudWatchLogsClient(getAwsClientConfig(config.region))
    this.logGroupName = config.logGroupName
    this.pollIntervalMs = config.pollIntervalMs ?? 1000
  }

  /**
   * Stream logs from a log stream.
   *
   * This is an async generator that yields log events as they arrive.
   * Use with `for await...of` to consume.
   *
   * @param logStreamName - The CloudWatch log stream name
   * @param startFromHead - Whether to start from the beginning or end
   * @param signal - AbortSignal to stop streaming
   */
  async *streamLogs(
    logStreamName: string,
    startFromHead: boolean = true,
    signal?: AbortSignal,
  ): AsyncGenerator<LogEvent, void, unknown> {
    let nextToken: string | undefined

    logger.info("Starting log stream", {
      logGroupName: this.logGroupName,
      logStreamName,
      startFromHead,
    })

    while (!signal?.aborted) {
      try {
        const result = await this.getLogEvents(logStreamName, nextToken, startFromHead)

        // Yield each log event
        for (const event of result.events ?? []) {
          yield {
            timestamp: event.timestamp ?? Date.now(),
            message: event.message ?? "",
            ingestionTime: event.ingestionTime,
          }
        }

        // Update token for next poll
        // If forward token is same as current, we've caught up
        if (result.nextForwardToken === nextToken) {
          // No new events, wait before polling again
          await this.sleep(this.pollIntervalMs)
        } else {
          nextToken = result.nextForwardToken
        }

        // After first fetch, always go forward
        startFromHead = true
      } catch (err) {
        // Log stream might not exist yet, keep trying
        if (this.isResourceNotFoundError(err)) {
          logger.debug("Log stream not found yet, waiting...", {
            logStreamName,
          })
          await this.sleep(this.pollIntervalMs * 2)
          continue
        }

        logger.error("Error fetching logs", {
          logStreamName,
          error: err instanceof Error ? err.message : String(err),
        })

        // Yield error as a log event so client knows something went wrong
        yield {
          timestamp: Date.now(),
          message: `[yaffle] Error fetching logs: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        }

        await this.sleep(this.pollIntervalMs)
      }
    }

    logger.info("Log stream ended", { logStreamName, aborted: signal?.aborted })
  }

  /**
   * Get a batch of log events.
   */
  private async getLogEvents(
    logStreamName: string,
    nextToken?: string,
    startFromHead?: boolean,
  ): Promise<GetLogEventsCommandOutput> {
    return this.client.send(
      new GetLogEventsCommand({
        logGroupName: this.logGroupName,
        logStreamName,
        nextToken,
        startFromHead: nextToken ? undefined : startFromHead,
        limit: 100,
      }),
    )
  }

  /**
   * Check if an error is a ResourceNotFoundException.
   */
  private isResourceNotFoundError(err: unknown): boolean {
    return err instanceof Error && "name" in err && err.name === "ResourceNotFoundException"
  }

  /**
   * Sleep for a specified duration.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}

/**
 * A single log event.
 */
export interface LogEvent {
  timestamp: number
  message: string
  ingestionTime?: number
  isError?: boolean
}

/**
 * Build the CloudWatch log stream name for an ECS task.
 *
 * Format: {log-stream-prefix}/{container-name}/{task-id}
 * Example: runner/runner/abc123def456
 *
 * @param taskArn - Full ECS task ARN
 * @param containerName - Container name (usually "runner")
 * @param streamPrefix - Log stream prefix from task definition
 */
export function buildLogStreamName(
  taskArn: string,
  containerName: string = "runner",
  streamPrefix: string = "runner",
): string {
  // Task ARN format: arn:aws:ecs:region:account:task/cluster-name/task-id
  const taskId = taskArn.split("/").pop()
  if (!taskId) {
    throw new Error(`Invalid task ARN: ${taskArn}`)
  }

  return `${streamPrefix}/${containerName}/${taskId}`
}
