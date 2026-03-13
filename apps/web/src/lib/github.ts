/**
 * Utilities for building GitHub URLs.
 *
 * Use these instead of string interpolation to avoid broken links
 * (e.g., forgetting to include the org in the path).
 */

export type GitHubUrlParams = {
  org: string
  repo: string
}

export function githubRepoUrl({ org, repo }: GitHubUrlParams): string {
  return `https://github.com/${org}/${repo}`
}

export function githubTreeUrl(
  { org, repo }: GitHubUrlParams,
  branch: string,
): string {
  return `https://github.com/${org}/${repo}/tree/${branch}`
}

export function githubCommitUrl(
  { org, repo }: GitHubUrlParams,
  sha: string,
): string {
  return `https://github.com/${org}/${repo}/commit/${sha}`
}

export function githubPullUrl(
  { org, repo }: GitHubUrlParams,
  prNumber: number,
): string {
  return `https://github.com/${org}/${repo}/pull/${prNumber}`
}
