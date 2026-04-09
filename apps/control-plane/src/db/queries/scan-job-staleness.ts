export interface ScanJobStalenessCandidate {
  status: "queued" | "running" | "completed" | "failed"
  queuedAt: Date
  startedAt: Date | null
  lastHeartbeat: Date | null
}

export function isStaleScanJob(
  job: ScanJobStalenessCandidate,
  staleThresholdMs: number,
  now: Date = new Date(),
): boolean {
  const cutoffMs = now.getTime() - staleThresholdMs

  if (job.status === "queued") {
    return !job.lastHeartbeat && job.queuedAt.getTime() < cutoffMs
  }

  if (job.status === "running") {
    if (job.lastHeartbeat) {
      return job.lastHeartbeat.getTime() < cutoffMs
    }

    if (job.startedAt) {
      return job.startedAt.getTime() < cutoffMs
    }

    return false
  }

  return false
}
