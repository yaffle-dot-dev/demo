import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs"

import type { TrafficControllerReconcileCommand } from "./contract.ts"

export interface ReconcileQueueClient {
  send(command: TrafficControllerReconcileCommand): Promise<void>
}

class AwsReconcileQueueClient implements ReconcileQueueClient {
  constructor(
    private readonly queueUrl: string,
    private readonly sqs: SQSClient,
  ) {}

  async send(command: TrafficControllerReconcileCommand): Promise<void> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(command),
      }),
    )
  }
}

export function getReconcileQueueUrl(): string {
  const value = process.env.RECONCILE_QUEUE_URL?.trim() ?? ""
  if (!value) {
    throw new Error("RECONCILE_QUEUE_URL must be configured")
  }

  return value
}

export function createReconcileQueueClient(): ReconcileQueueClient {
  return new AwsReconcileQueueClient(getReconcileQueueUrl(), new SQSClient({}))
}
