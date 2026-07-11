import { describe, expect, test } from "@yaffle/test"

import { inspectAutomaticPreviewIsolationWorkspace } from "./automatic-preview-isolation.ts"

describe("inspectAutomaticPreviewIsolationWorkspace", () => {
  test("requires Cloud review for ordinary managed resources", () => {
    const result = inspectAutomaticPreviewIsolationWorkspace("infra", [
      {
        path: "infra/main.tf",
        content: `resource "aws_s3_bucket" "uploads" { bucket = "uploads" }`,
      },
    ])

    expect(result.status).toBe("review_required")
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        code: "resource_review_required",
        resourceAddress: "aws_s3_bucket.uploads",
      }),
    )
  })

  test("blocks imports, provisioners, and prevent_destroy", () => {
    const result = inspectAutomaticPreviewIsolationWorkspace("infra", [
      {
        path: "infra/main.tf",
        content: `
resource "aws_s3_bucket" "uploads" {
  bucket = "uploads"

  lifecycle {
    prevent_destroy = true
  }

  provisioner "local-exec" {
    command = "./configure.sh"
  }
}

import {
  to = aws_s3_bucket.uploads
  id = "uploads"
}
`,
      },
    ])

    expect(result.status).toBe("blocked")
    expect(result.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining([
        "import_not_allowed",
        "prevent_destroy_not_allowed",
        "provisioner_not_allowed",
      ]),
    )
  })

  test("requires review for modules whose managed resources are not materialized yet", () => {
    const result = inspectAutomaticPreviewIsolationWorkspace("infra", [
      {
        path: "infra/main.tf",
        content: `module "network" { source = "./network" }`,
      },
    ])

    expect(result.status).toBe("review_required")
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        code: "module_review_required",
        resourceAddress: "module.network",
      }),
    )
  })

  test("blocks removed blocks that can detach transient resources from state", () => {
    const result = inspectAutomaticPreviewIsolationWorkspace("infra", [
      {
        path: "infra/main.tf",
        content: `
removed {
  from = aws_s3_bucket.uploads

  lifecycle {
    destroy = false
  }
}
`,
      },
    ])

    expect(result.status).toBe("blocked")
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        code: "removed_not_allowed",
        resourceAddress: "aws_s3_bucket.uploads",
      }),
    )
  })

  test("fails closed when HCL cannot be parsed", () => {
    const result = inspectAutomaticPreviewIsolationWorkspace("infra", [
      {
        path: "infra/main.tf",
        content: `resource "aws_s3_bucket" "uploads" { bucket = }`,
      },
    ])

    expect(result.status).toBe("blocked")
    expect(result.findings[0]).toEqual(
      expect.objectContaining({
        code: "hcl_parse_error",
        filePath: "infra/main.tf",
      }),
    )
  })

  test("allows read-only data sources and empty workspaces", () => {
    const result = inspectAutomaticPreviewIsolationWorkspace("infra", [
      {
        path: "infra/main.tf",
        content: `data "aws_caller_identity" "current" {}`,
      },
    ])

    expect(result).toEqual({
      workspacePath: "infra",
      status: "ready",
      findings: [],
    })
  })
})
