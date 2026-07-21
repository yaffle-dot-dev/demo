export class YaffleError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message)
    this.name = "YaffleError"
  }
}

export class WebhookVerificationError extends YaffleError {
  constructor(message = "webhook signature verification failed") {
    super(message, "WEBHOOK_VERIFICATION_FAILED")
    this.name = "WebhookVerificationError"
  }
}

export class GitHubAuthError extends YaffleError {
  constructor(message = "github authentication failed") {
    super(message, "GITHUB_AUTH_FAILED")
    this.name = "GitHubAuthError"
  }
}

export class PreviewNotFoundError extends YaffleError {
  constructor(orgId: string, repo: string, prNumber: number) {
    super(`preview not found for ${repo}#${prNumber} in org ${orgId}`, "PREVIEW_NOT_FOUND")
    this.name = "PreviewNotFoundError"
  }
}
