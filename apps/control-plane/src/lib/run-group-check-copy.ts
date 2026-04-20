export type RunGroupCheckSummaryKind = "pending" | "success" | "failure" | "cancelled"

const DEFAULT_SUMMARIES: Record<RunGroupCheckSummaryKind, string> = {
  pending: "Yaffle picked up this commit and is lining up your infrastructure changes.",
  success: "Yaffle finished processing the infrastructure changes for this commit.",
  failure: "Yaffle hit a snag while processing the infrastructure changes for this commit.",
  cancelled: "Yaffle did not finish processing the infrastructure changes for this commit.",
}

const PIRATE_SUMMARIES: Record<RunGroupCheckSummaryKind, string> = {
  pending: "Yaffle caught this commit and is charting your infrastructure changes, matey.",
  success: "Yaffle finished processing the infrastructure changes for this commit. Fair winds, matey.",
  failure: "Yaffle hit rough seas while processing the infrastructure changes for this commit, matey.",
  cancelled: "Yaffle did not finish processing the infrastructure changes for this commit, matey.",
}

export function getRunGroupCheckSummary(
  kind: RunGroupCheckSummaryKind,
  now: Date = new Date(),
): string {
  if (isTalkLikeAPirateDay(now)) {
    return PIRATE_SUMMARIES[kind]
  }

  return DEFAULT_SUMMARIES[kind]
}

function isTalkLikeAPirateDay(now: Date): boolean {
  return now.getMonth() === 8 && now.getDate() === 19
}
