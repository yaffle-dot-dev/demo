import { describe, expect, test } from "@yaffle/test"

import { buildOrgBrokerPolicy } from "./org-provisioning.ts"

describe("buildOrgBrokerPolicy", () => {
  test("separates AssumeRole from TagSession for customer roles", () => {
    process.env.YAFFLE_STATE_BUCKET = "test-state-bucket"
    process.env.YAFFLE_CONTROL_PLANE_ROLE_ARN = "arn:aws:iam::123456789012:role/test-control-plane"

    const policy = JSON.parse(
      buildOrgBrokerPolicy({
        orgSlug: "yaffle-dot-dev",
        kmsKeyArn: "arn:aws:kms:us-east-1:123456789012:key/example",
        customerRoleArns: [
          "arn:aws:iam::123456789012:role/app-main",
          "arn:aws:iam::123456789012:role/app-preview",
        ],
      }),
    ) as {
      Statement: Array<{
        Sid: string
        Effect: string
        Action: string | string[]
        Resource: string | string[]
      }>
    }

    expect(policy.Statement).toContainEqual({
      Sid: "AssumeCustomerRoles",
      Effect: "Allow",
      Action: "sts:AssumeRole",
      Resource: [
        "arn:aws:iam::123456789012:role/app-main",
        "arn:aws:iam::123456789012:role/app-preview",
      ],
    })

    expect(policy.Statement).toContainEqual({
      Sid: "TagCustomerRoleSessions",
      Effect: "Allow",
      Action: "sts:TagSession",
      Resource: "*",
    })
  })
})
