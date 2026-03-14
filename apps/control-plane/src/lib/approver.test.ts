import { describe, expect, it } from "bun:test"
import {
  parseApprover,
  serializeApprover,
  isValidApproverString,
  getApproverValidationError,
  getApproverDisplay,
  getApproverDisplayFromString,
  isUserAuthorizedApprover,
  ApproverParseError,
  type GitHubUserApprover,
  type GitHubTeamApprover,
  type TeamMembershipChecker,
} from "./approver.ts"

describe("parseApprover", () => {
  describe("github:user", () => {
    it("parses valid github user", () => {
      const approver = parseApprover("github:user:alice")
      expect(approver).toEqual({
        provider: "github",
        type: "user",
        username: "alice",
      })
    })

    it("normalizes username to lowercase", () => {
      const approver = parseApprover("github:user:AlIcE")
      expect(approver).toEqual({
        provider: "github",
        type: "user",
        username: "alice",
      })
    })

    it("normalizes provider and type to lowercase", () => {
      const approver = parseApprover("GITHUB:USER:alice")
      expect(approver).toEqual({
        provider: "github",
        type: "user",
        username: "alice",
      })
    })

    it("trims whitespace", () => {
      const approver = parseApprover("  github:user:alice  ")
      expect(approver).toEqual({
        provider: "github",
        type: "user",
        username: "alice",
      })
    })

    it("throws on empty username", () => {
      expect(() => parseApprover("github:user:")).toThrow(ApproverParseError)
      expect(() => parseApprover("github:user:   ")).toThrow(ApproverParseError)
    })

    it("throws on username with slash", () => {
      expect(() => parseApprover("github:user:org/user")).toThrow(ApproverParseError)
    })
  })

  describe("github:team", () => {
    it("parses valid github team", () => {
      const approver = parseApprover("github:team:yaffle-dot-dev/platform-engineering")
      expect(approver).toEqual({
        provider: "github",
        type: "team",
        org: "yaffle-dot-dev",
        team: "platform-engineering",
      })
    })

    it("normalizes org and team to lowercase", () => {
      const approver = parseApprover("github:team:Yaffle-Dot-Dev/Platform-Engineering")
      expect(approver).toEqual({
        provider: "github",
        type: "team",
        org: "yaffle-dot-dev",
        team: "platform-engineering",
      })
    })

    it("throws on missing slash", () => {
      expect(() => parseApprover("github:team:just-a-team")).toThrow(ApproverParseError)
    })

    it("throws on empty org", () => {
      expect(() => parseApprover("github:team:/team")).toThrow(ApproverParseError)
    })

    it("throws on empty team", () => {
      expect(() => parseApprover("github:team:org/")).toThrow(ApproverParseError)
    })

    it("handles team with multiple slashes (uses first as separator)", () => {
      // This is a valid case - team slugs shouldn't have slashes, but we take everything after the first
      const approver = parseApprover("github:team:org/team/subteam")
      expect(approver).toEqual({
        provider: "github",
        type: "team",
        org: "org",
        team: "team/subteam",
      })
    })
  })

  describe("error cases", () => {
    it("throws on empty string", () => {
      expect(() => parseApprover("")).toThrow(ApproverParseError)
      expect(() => parseApprover("   ")).toThrow(ApproverParseError)
    })

    it("throws on missing segments", () => {
      expect(() => parseApprover("github")).toThrow(ApproverParseError)
      expect(() => parseApprover("github:user")).toThrow(ApproverParseError)
    })

    it("throws on unknown provider", () => {
      expect(() => parseApprover("gitlab:user:alice")).toThrow(ApproverParseError)
      const err = getApproverValidationError("gitlab:user:alice")
      expect(err).toContain("Unknown approver provider")
      expect(err).toContain("gitlab")
    })

    it("throws on unknown github type", () => {
      expect(() => parseApprover("github:org:myorg")).toThrow(ApproverParseError)
      const err = getApproverValidationError("github:org:myorg")
      expect(err).toContain("Unknown GitHub approver type")
      expect(err).toContain("org")
    })

    it("includes raw string in error", () => {
      try {
        parseApprover("invalid")
      } catch (e) {
        expect(e).toBeInstanceOf(ApproverParseError)
        expect((e as ApproverParseError).raw).toBe("invalid")
      }
    })
  })
})

describe("serializeApprover", () => {
  it("serializes github user", () => {
    const approver: GitHubUserApprover = {
      provider: "github",
      type: "user",
      username: "alice",
    }
    expect(serializeApprover(approver)).toBe("github:user:alice")
  })

  it("serializes github team", () => {
    const approver: GitHubTeamApprover = {
      provider: "github",
      type: "team",
      org: "yaffle-dot-dev",
      team: "platform-engineering",
    }
    expect(serializeApprover(approver)).toBe("github:team:yaffle-dot-dev/platform-engineering")
  })

  it("round-trips github user", () => {
    const original = "github:user:alice"
    const parsed = parseApprover(original)
    const serialized = serializeApprover(parsed)
    expect(serialized).toBe(original)
  })

  it("round-trips github team", () => {
    const original = "github:team:org/team"
    const parsed = parseApprover(original)
    const serialized = serializeApprover(parsed)
    expect(serialized).toBe(original)
  })

  it("normalizes on round-trip", () => {
    const original = "GITHUB:USER:ALICE"
    const parsed = parseApprover(original)
    const serialized = serializeApprover(parsed)
    expect(serialized).toBe("github:user:alice")
  })
})

describe("isValidApproverString", () => {
  it("returns true for valid github user", () => {
    expect(isValidApproverString("github:user:alice")).toBe(true)
  })

  it("returns true for valid github team", () => {
    expect(isValidApproverString("github:team:org/team")).toBe(true)
  })

  it("returns false for invalid format", () => {
    expect(isValidApproverString("")).toBe(false)
    expect(isValidApproverString("invalid")).toBe(false)
    expect(isValidApproverString("github:user")).toBe(false)
    expect(isValidApproverString("gitlab:user:alice")).toBe(false)
  })
})

describe("getApproverValidationError", () => {
  it("returns undefined for valid approvers", () => {
    expect(getApproverValidationError("github:user:alice")).toBeUndefined()
    expect(getApproverValidationError("github:team:org/team")).toBeUndefined()
  })

  it("returns error message for invalid approvers", () => {
    const err = getApproverValidationError("invalid")
    expect(err).toBeDefined()
    expect(err).toContain("Invalid approver format")
  })
})

describe("getApproverDisplay", () => {
  it("formats github user for display", () => {
    const approver: GitHubUserApprover = {
      provider: "github",
      type: "user",
      username: "alice",
    }
    const display = getApproverDisplay(approver)
    expect(display).toEqual({
      label: "@alice",
      url: "https://github.com/alice",
      iconType: "user",
      provider: "GitHub",
    })
  })

  it("formats github team for display", () => {
    const approver: GitHubTeamApprover = {
      provider: "github",
      type: "team",
      org: "yaffle-dot-dev",
      team: "platform-engineering",
    }
    const display = getApproverDisplay(approver)
    expect(display).toEqual({
      label: "yaffle-dot-dev/platform-engineering",
      url: "https://github.com/orgs/yaffle-dot-dev/teams/platform-engineering",
      iconType: "team",
      provider: "GitHub",
    })
  })
})

describe("getApproverDisplayFromString", () => {
  it("parses and displays valid approver", () => {
    const display = getApproverDisplayFromString("github:user:alice")
    expect(display).toBeDefined()
    expect(display?.label).toBe("@alice")
  })

  it("returns undefined for invalid string", () => {
    const display = getApproverDisplayFromString("invalid")
    expect(display).toBeUndefined()
  })
})

describe("isUserAuthorizedApprover", () => {
  // Create a mock team membership checker for each test
  function createMockChecker(returnValue: boolean): TeamMembershipChecker & { calls: Array<[number, string, string, string]> } {
    const calls: Array<[number, string, string, string]> = []
    const checker = ((installationId: number, org: string, team: string, username: string) => {
      calls.push([installationId, org, team, username])
      return Promise.resolve(returnValue)
    }) as TeamMembershipChecker & { calls: Array<[number, string, string, string]> }
    checker.calls = calls
    return checker
  }

  it("returns true for empty approvers list (anyone can approve)", async () => {
    const mockChecker = createMockChecker(false)
    const authorized = await isUserAuthorizedApprover(
      [],
      { githubUsername: "alice", installationId: 123 },
      mockChecker,
    )
    expect(authorized).toBe(true)
  })

  it("returns true for matching github user (case insensitive)", async () => {
    const mockChecker = createMockChecker(false)
    const authorized = await isUserAuthorizedApprover(
      ["github:user:alice"],
      { githubUsername: "Alice", installationId: 123 },
      mockChecker,
    )
    expect(authorized).toBe(true)
  })

  it("returns false for non-matching github user", async () => {
    const mockChecker = createMockChecker(false)
    const authorized = await isUserAuthorizedApprover(
      ["github:user:alice"],
      { githubUsername: "bob", installationId: 123 },
      mockChecker,
    )
    expect(authorized).toBe(false)
  })

  it("returns true if any approver matches (user)", async () => {
    const mockChecker = createMockChecker(false)
    const authorized = await isUserAuthorizedApprover(
      ["github:user:alice", "github:user:bob", "github:user:carol"],
      { githubUsername: "bob", installationId: 123 },
      mockChecker,
    )
    expect(authorized).toBe(true)
  })

  it("checks team membership for github:team approvers", async () => {
    const mockChecker = createMockChecker(true)

    const authorized = await isUserAuthorizedApprover(
      ["github:team:org/team"],
      { githubUsername: "alice", installationId: 123 },
      mockChecker,
    )

    expect(authorized).toBe(true)
    expect(mockChecker.calls).toHaveLength(1)
    expect(mockChecker.calls[0]).toEqual([123, "org", "team", "alice"])
  })

  it("returns false if team membership check fails", async () => {
    const mockChecker = createMockChecker(false)

    const authorized = await isUserAuthorizedApprover(
      ["github:team:org/team"],
      { githubUsername: "alice", installationId: 123 },
      mockChecker,
    )

    expect(authorized).toBe(false)
  })

  it("stops checking after first match", async () => {
    const mockChecker = createMockChecker(true)

    // First approver matches (user)
    const authorized = await isUserAuthorizedApprover(
      ["github:user:alice", "github:team:org/team"],
      { githubUsername: "alice", installationId: 123 },
      mockChecker,
    )

    expect(authorized).toBe(true)
    // Team membership should not be checked since user already matched
    expect(mockChecker.calls).toHaveLength(0)
  })

  it("checks team if user doesn't match", async () => {
    const mockChecker = createMockChecker(true)

    const authorized = await isUserAuthorizedApprover(
      ["github:user:bob", "github:team:org/team"],
      { githubUsername: "alice", installationId: 123 },
      mockChecker,
    )

    expect(authorized).toBe(true)
    expect(mockChecker.calls).toHaveLength(1)
  })

  it("handles mixed approvers when none match", async () => {
    const mockChecker = createMockChecker(false)

    // Neither user nor team matches
    const authorized = await isUserAuthorizedApprover(
      ["github:user:bob", "github:team:org/team"],
      { githubUsername: "alice", installationId: 123 },
      mockChecker,
    )

    expect(authorized).toBe(false)
  })
})
