import { describe, expect, test } from "@yaffle/test"

import { normalizePem } from "./github-app-client.ts"

describe("normalizePem", () => {
  test("converts escaped newlines into a multiline pem", () => {
    const pem = normalizePem(
      "-----BEGIN PRIVATE KEY-----\\nabc123\\ndef456\\n-----END PRIVATE KEY-----",
    )

    expect(pem).toBe(
      "-----BEGIN PRIVATE KEY-----\nabc123\ndef456\n-----END PRIVATE KEY-----",
    )
  })

  test("reformats single-line pem bodies into 64-char lines", () => {
    const body = "a".repeat(80)
    const pem = normalizePem(`-----BEGIN PRIVATE KEY----- ${body} -----END PRIVATE KEY-----`)

    expect(pem).toBe(
      `-----BEGIN PRIVATE KEY-----\n${"a".repeat(64)}\n${"a".repeat(16)}\n-----END PRIVATE KEY-----`,
    )
  })
})
