import { describe, expect, test } from "@yaffle/test"

import {
  getAutomaticIsolationPreflightOutcome,
  validateAutomaticIsolationPreflightCoverage,
} from "./automatic-preview-isolation-preflight.ts"

describe("getAutomaticIsolationPreflightOutcome", () => {
  test("returns action-required copy for unverified resources", () => {
    const outcome = getAutomaticIsolationPreflightOutcome({
      status: "review_required",
      workspaces: [
        {
          workspacePath: "infra",
          status: "review_required",
          findings: [
            {
              code: "resource_review_required",
              filePath: "infra/main.tf",
              resourceAddress: "aws_s3_bucket.uploads",
              message: "Review is required.",
            },
          ],
        },
      ],
    })

    expect(outcome).toEqual(
      expect.objectContaining({
        runGroupStatus: "isolation_review_required",
        conclusion: "action_required",
        title: "Automatic preview isolation review required",
      }),
    )
    expect(outcome?.summary).toContain("aws_s3_bucket.uploads")
    expect(outcome?.summary).toContain("No Terraform plan was created")
  })

  test("returns failure copy for forbidden constructs", () => {
    const outcome = getAutomaticIsolationPreflightOutcome({
      status: "blocked",
      workspaces: [
        {
          workspacePath: "infra",
          status: "blocked",
          findings: [
            {
              code: "import_not_allowed",
              filePath: "infra/main.tf",
              message: "Imports are not allowed.",
            },
          ],
        },
      ],
    })

    expect(outcome).toEqual(
      expect.objectContaining({
        runGroupStatus: "isolation_blocked",
        conclusion: "failure",
        title: "Automatic preview isolation blocked",
      }),
    )
  })

  test("does not gate a ready or absent preflight", () => {
    expect(getAutomaticIsolationPreflightOutcome(undefined)).toBeNull()
    expect(getAutomaticIsolationPreflightOutcome({ status: "ready", workspaces: [] })).toBeNull()
  })

  test("fails closed when scanner coverage is absent or inconsistent", () => {
    expect(validateAutomaticIsolationPreflightCoverage(["infra"], undefined)).toContain(
      "coverage mismatch",
    )
    expect(validateAutomaticIsolationPreflightCoverage([], undefined)).toBeNull()
    expect(
      validateAutomaticIsolationPreflightCoverage(["infra"], {
        status: "ready",
        workspaces: [
          {
            workspacePath: "infra",
            status: "review_required",
            findings: [
              {
                code: "resource_review_required",
                filePath: "infra/main.tf",
                resourceAddress: "aws_s3_bucket.uploads",
                message: "Review is required.",
              },
            ],
          },
        ],
      }),
    ).toContain("status mismatch")
  })
})
