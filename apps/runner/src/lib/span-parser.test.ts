import { describe, test, expect } from "@yaffle/test"
import { ResourceSpanParser, type ResourceSpanEvent } from "./span-parser.ts"

function collectEvents(input: string): ResourceSpanEvent[] {
  const events: ResourceSpanEvent[] = []
  const parser = new ResourceSpanParser((e) => events.push(e))
  parser.feed(input)
  parser.flush()
  return events
}

describe("ResourceSpanParser", () => {
  test("parses create start event", () => {
    const events = collectEvents("aws_acm_certificate_validation.main: Creating...\n")
    expect(events).toHaveLength(1)
    expect(events[0].resourceAddress).toBe("aws_acm_certificate_validation.main")
    expect(events[0].resourceType).toBe("aws_acm_certificate_validation")
    expect(events[0].action).toBe("create")
    expect(events[0].event).toBe("started")
  })

  test("parses modify start event with id", () => {
    const events = collectEvents("aws_cloudfront_distribution.main: Modifying... [id=EWVN2QG1SE6JF]\n")
    expect(events).toHaveLength(1)
    expect(events[0].action).toBe("update")
    expect(events[0].event).toBe("started")
  })

  test("parses destroy start event", () => {
    const events = collectEvents("aws_instance.bar: Destroying...\n")
    expect(events).toHaveLength(1)
    expect(events[0].action).toBe("delete")
    expect(events[0].event).toBe("started")
  })

  test("parses 'Refreshing state...' as refresh start", () => {
    const events = collectEvents("module.core.aws_eip.nat[1]: Refreshing state... [id=eipalloc-09855471d455edc7b]\n")
    expect(events).toHaveLength(1)
    expect(events[0].resourceAddress).toBe("module.core.aws_eip.nat[1]")
    expect(events[0].resourceType).toBe("aws_eip")
    expect(events[0].action).toBe("refresh")
    expect(events[0].event).toBe("started")
  })

  test("parses Reading start event", () => {
    const events = collectEvents("module.core.data.aws_availability_zones.available: Reading...\n")
    expect(events).toHaveLength(1)
    expect(events[0].resourceAddress).toBe("module.core.data.aws_availability_zones.available")
    expect(events[0].resourceType).toBe("aws_availability_zones")
    expect(events[0].action).toBe("read")
    expect(events[0].event).toBe("started")
  })

  test("parses progress event with id and elapsed", () => {
    const events = collectEvents("aws_cloudfront_distribution.main: Still modifying... [id=EWVN2QG1SE6JF, 10s elapsed]\n")
    expect(events).toHaveLength(1)
    expect(events[0].event).toBe("progress")
    expect(events[0].action).toBe("update")
    expect(events[0].elapsedMs).toBe(10000)
  })

  test("parses progress event with minutes", () => {
    const events = collectEvents("aws_cloudfront_distribution.main: Still modifying... [id=EWVN2QG1SE6JF, 1m0s elapsed]\n")
    expect(events).toHaveLength(1)
    expect(events[0].elapsedMs).toBe(60000)
  })

  test("parses progress event without id (simple format)", () => {
    const events = collectEvents("aws_s3_bucket.foo: Still creating... [30s elapsed]\n")
    expect(events).toHaveLength(1)
    expect(events[0].event).toBe("progress")
    expect(events[0].elapsedMs).toBe(30000)
  })

  test("parses creation complete event with 0s", () => {
    const events = collectEvents("aws_acm_certificate_validation.main: Creation complete after 0s [id=2026-03-17 02:17:44.007 +0000 UTC]\n")
    expect(events).toHaveLength(1)
    expect(events[0].event).toBe("complete")
    expect(events[0].action).toBe("create")
    expect(events[0].elapsedMs).toBe(0)
    expect(events[0].message).toBe("id=2026-03-17 02:17:44.007 +0000 UTC")
  })

  test("parses modification complete with minutes+seconds", () => {
    const events = collectEvents("aws_cloudfront_distribution.main: Modifications complete after 1m8s [id=EWVN2QG1SE6JF]\n")
    expect(events).toHaveLength(1)
    expect(events[0].event).toBe("complete")
    expect(events[0].action).toBe("update")
    expect(events[0].elapsedMs).toBe(68000) // 1m8s = 68s
    expect(events[0].message).toBe("id=EWVN2QG1SE6JF")
  })

  test("parses destruction complete without detail", () => {
    const events = collectEvents("aws_instance.bar: Destruction complete after 15s\n")
    expect(events).toHaveLength(1)
    expect(events[0].event).toBe("complete")
    expect(events[0].action).toBe("delete")
    expect(events[0].elapsedMs).toBe(15000)
    expect(events[0].message).toBeUndefined()
  })

  test("handles module-prefixed resource addresses", () => {
    const events = collectEvents("module.vpc.aws_subnet.public[0]: Creating...\n")
    expect(events).toHaveLength(1)
    expect(events[0].resourceAddress).toBe("module.vpc.aws_subnet.public[0]")
    expect(events[0].resourceType).toBe("aws_subnet")
  })

  test("handles nested module addresses", () => {
    const events = collectEvents("module.a.module.b.aws_instance.main: Creating...\n")
    expect(events).toHaveLength(1)
    expect(events[0].resourceAddress).toBe("module.a.module.b.aws_instance.main")
    expect(events[0].resourceType).toBe("aws_instance")
  })

  test("handles string-indexed resources", () => {
    const events = collectEvents('aws_iam_policy.policies["admin"]: Creating...\n')
    expect(events).toHaveLength(1)
    expect(events[0].resourceAddress).toBe('aws_iam_policy.policies["admin"]')
    expect(events[0].resourceType).toBe("aws_iam_policy")
  })

  test("handles partial line buffering", () => {
    const events: ResourceSpanEvent[] = []
    const parser = new ResourceSpanParser((e) => events.push(e))

    parser.feed("aws_s3_bucket.foo: Cre")
    expect(events).toHaveLength(0)

    parser.feed("ating...\n")
    expect(events).toHaveLength(1)
    expect(events[0].action).toBe("create")
    expect(events[0].event).toBe("started")
  })

  test("handles multiple lines in a single chunk", () => {
    const events = collectEvents(
      "aws_s3_bucket.foo: Creating...\naws_instance.bar: Modifying... [id=i-123]\n",
    )
    expect(events).toHaveLength(2)
    expect(events[0].resourceAddress).toBe("aws_s3_bucket.foo")
    expect(events[1].resourceAddress).toBe("aws_instance.bar")
  })

  test("parses a full cloudfront modify lifecycle", () => {
    const events = collectEvents(
      [
        "aws_cloudfront_distribution.main: Modifying... [id=EWVN2QG1SE6JF]",
        "aws_cloudfront_distribution.main: Still modifying... [id=EWVN2QG1SE6JF, 10s elapsed]",
        "aws_cloudfront_distribution.main: Still modifying... [id=EWVN2QG1SE6JF, 20s elapsed]",
        "aws_cloudfront_distribution.main: Modifications complete after 1m8s [id=EWVN2QG1SE6JF]",
      ].join("\n") + "\n",
    )
    expect(events).toHaveLength(4)
    expect(events[0].event).toBe("started")
    expect(events[1].event).toBe("progress")
    expect(events[1].elapsedMs).toBe(10000)
    expect(events[2].event).toBe("progress")
    expect(events[2].elapsedMs).toBe(20000)
    expect(events[3].event).toBe("complete")
    expect(events[3].elapsedMs).toBe(68000)
  })

  test("parses plan refresh lines", () => {
    const events = collectEvents(
      [
        "aws_acm_certificate.main: Refreshing state... [id=arn:aws:acm:us-east-1:870923192739:certificate/0d3d5281-0191-4dc4-845e-3cef467ffda7]",
        "module.core.data.aws_availability_zones.available: Reading...",
        "module.core.aws_eip.nat[1]: Refreshing state... [id=eipalloc-09855471d455edc7b]",
      ].join("\n") + "\n",
    )
    expect(events).toHaveLength(3)
    expect(events[0].action).toBe("refresh")
    expect(events[0].resourceType).toBe("aws_acm_certificate")
    expect(events[1].action).toBe("read")
    expect(events[1].resourceType).toBe("aws_availability_zones")
    expect(events[2].action).toBe("refresh")
    expect(events[2].resourceType).toBe("aws_eip")
  })

  test("ignores unrelated lines", () => {
    const events = collectEvents(
      [
        "Terraform will perform the following actions:",
        "",
        "  # aws_s3_bucket.foo will be created",
        "  + resource \"aws_s3_bucket\" \"foo\" {",
        "      + bucket = \"my-bucket\"",
        "    }",
        "",
        "Plan: 1 to add, 0 to change, 0 to destroy.",
        "aws_s3_bucket.foo: Creating...",
        "aws_s3_bucket.foo: Creation complete after 2s [id=my-bucket]",
      ].join("\n") + "\n",
    )
    expect(events).toHaveLength(2)
    expect(events[0].event).toBe("started")
    expect(events[1].event).toBe("complete")
  })

  test("flush emits partial buffer", () => {
    const events: ResourceSpanEvent[] = []
    const parser = new ResourceSpanParser((e) => events.push(e))
    parser.feed("aws_s3_bucket.foo: Creating...")
    expect(events).toHaveLength(0)
    parser.flush()
    expect(events).toHaveLength(1)
  })

  test("error event uses last resource context", () => {
    const events = collectEvents(
      "aws_s3_bucket.foo: Creating...\nError: insufficient permissions\n",
    )
    expect(events).toHaveLength(2)
    expect(events[1].event).toBe("error")
    expect(events[1].resourceAddress).toBe("aws_s3_bucket.foo")
    expect(events[1].action).toBe("create")
    expect(events[1].message).toBe("insufficient permissions")
  })

  test("parseDuration handles minutes+seconds in complete", () => {
    const events = collectEvents("aws_cloudfront_function.static_routing: Modifications complete after 2s [id=yaffle-static-routing-main-use1]\n")
    expect(events[0].elapsedMs).toBe(2000)
  })
})
