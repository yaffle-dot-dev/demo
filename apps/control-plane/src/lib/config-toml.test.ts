import { describe, expect, test } from "bun:test"

import {
  buildPrEnvironmentName,
  ConfigError,
  findPushTriggerEnvironment,
  getWorkspacesForEnvironment,
  isApprovalRequired,
  matchConsumerSelector,
  matchBranchPattern,
  matchesPullRequestTrigger,
  matchRefPattern,
  matchWorkspacePattern,
  parseConsumerSelector,
  parsePrEnvironmentName,
  parseYaffleToml,
  resolveApprovers,
  validateWorkspacePaths,
} from "./config-toml.ts"

describe("parseYaffleToml", () => {
  test("parses valid config", () => {
    const toml = `
version = 1

[[environments]]
name = "main"

[[environments]]
name = "staging"

[[workspaces]]
path = "infra/shared"
environments = ["main", "staging"]

[[workspaces]]
path = "apps/web/infra"
environments = ["*"]

[[triggers.github.push]]
ref = "refs/heads/main"
environment = "main"

[[triggers.github.push]]
ref = "refs/heads/staging"
environment = "staging"

[[triggers.github.pull_request]]
branch_pattern = "*"
`

    const config = parseYaffleToml(toml)

    expect(config.version).toBe(1)
    expect(config.environments).toHaveLength(2)
    expect(config.environments[0].name).toBe("main")
    expect(config.environments[1].name).toBe("staging")
    expect(config.workspaces).toHaveLength(2)
    expect(config.workspaces[0].path).toBe("infra/shared")
    expect(config.workspaces[0].environments).toEqual(["main", "staging"])
    expect(config.workspaces[1].path).toBe("apps/web/infra")
    expect(config.workspaces[1].environments).toBe("*")
    expect(config.triggers.github?.push).toHaveLength(2)
    expect(config.triggers.github?.push?.[0].ref_patterns).toEqual(["refs/heads/main"])
    expect(config.triggers.github?.push?.[0].exclude_ref_patterns).toEqual([])
    expect(config.triggers.github?.pull_request).toHaveLength(1)
  })

  test("normalizes single environment string to array", () => {
    const toml = `
version = 1

[[environments]]
name = "main"

[[workspaces]]
path = "infra"
environments = "main"

[[triggers.github.push]]
ref = "refs/heads/main"
environment = "main"
`

    const config = parseYaffleToml(toml)
    expect(config.workspaces[0].environments).toEqual(["main"])
  })

  test("normalizes array with '*' to just '*'", () => {
    const toml = `
version = 1

[[workspaces]]
path = "infra"
environments = ["*"]
`

    const config = parseYaffleToml(toml)
    expect(config.workspaces[0].environments).toBe("*")
  })

  test("rejects invalid version", () => {
    const toml = `
version = 2

[[workspaces]]
path = "infra"
environments = ["*"]
`

    expect(() => parseYaffleToml(toml)).toThrow(ConfigError)
    expect(() => parseYaffleToml(toml)).toThrow(/version/)
  })

  test("rejects missing workspaces", () => {
    const toml = `
version = 1
`

    expect(() => parseYaffleToml(toml)).toThrow(ConfigError)
    expect(() => parseYaffleToml(toml)).toThrow(/workspaces/)
  })

  test("rejects duplicate environment names", () => {
    const toml = `
version = 1

[[environments]]
name = "main"

[[environments]]
name = "main"

[[workspaces]]
path = "infra"
environments = ["main"]

[[triggers.github.push]]
ref = "refs/heads/main"
environment = "main"
`

    expect(() => parseYaffleToml(toml)).toThrow(ConfigError)
    expect(() => parseYaffleToml(toml)).toThrow(/Duplicate environment names/)
  })

  test("rejects duplicate workspace paths", () => {
    const toml = `
version = 1

[[workspaces]]
path = "infra"
environments = ["*"]

[[workspaces]]
path = "infra"
environments = ["*"]
`

    expect(() => parseYaffleToml(toml)).toThrow(ConfigError)
    expect(() => parseYaffleToml(toml)).toThrow(/Duplicate workspace paths/)
  })

  test("rejects workspace referencing undeclared environment", () => {
    const toml = `
version = 1

[[environments]]
name = "main"

[[workspaces]]
path = "infra"
environments = ["main", "staging"]

[[triggers.github.push]]
ref = "refs/heads/main"
environment = "main"
`

    expect(() => parseYaffleToml(toml)).toThrow(ConfigError)
    expect(() => parseYaffleToml(toml)).toThrow(/undeclared environment "staging"/)
  })

  test("rejects push trigger referencing undeclared environment", () => {
    const toml = `
version = 1

[[environments]]
name = "main"

[[workspaces]]
path = "infra"
environments = ["main"]

[[triggers.github.push]]
ref = "refs/heads/production"
environment = "production"
`

    expect(() => parseYaffleToml(toml)).toThrow(ConfigError)
    expect(() => parseYaffleToml(toml)).toThrow(/undeclared environment "production"/)
  })

  test("rejects ref without proper prefix", () => {
    const toml = `
version = 1

[[environments]]
name = "main"

[[workspaces]]
path = "infra"
environments = ["main"]

[[triggers.github.push]]
ref = "main"
environment = "main"
`

    expect(() => parseYaffleToml(toml)).toThrow(ConfigError)
    expect(() => parseYaffleToml(toml)).toThrow(/ref must start with/)
  })

  test("rejects ref with only prefix", () => {
    const toml = `
version = 1

[[environments]]
name = "main"

[[workspaces]]
path = "infra"
environments = ["main"]

[[triggers.github.push]]
ref = "refs/heads/"
environment = "main"
`

    expect(() => parseYaffleToml(toml)).toThrow(ConfigError)
    expect(() => parseYaffleToml(toml)).toThrow(/ref must have a name after the prefix/)
  })

  test("accepts refs/tags/ prefix", () => {
    const toml = `
version = 1

[[environments]]
name = "release"

[[workspaces]]
path = "infra"
environments = ["release"]

[[triggers.github.push]]
ref = "refs/tags/v*"
environment = "release"
`

    const config = parseYaffleToml(toml)
    expect(config.triggers.github?.push?.[0].ref_patterns).toEqual(["refs/tags/v*"])
  })

  test("parses ref pattern arrays with excludes", () => {
    const toml = `
version = 1

[[environments]]
name = "main"

[[workspaces]]
path = "infra"
environments = ["main"]

[[triggers.github.push]]
ref_patterns = ["refs/heads/**"]
exclude_ref_patterns = ["refs/heads/dependabot/**"]
environment = "main"
`

    const config = parseYaffleToml(toml)

    expect(config.triggers.github?.push).toEqual([
      {
        ref_patterns: ["refs/heads/**"],
        exclude_ref_patterns: ["refs/heads/dependabot/**"],
        environment: "main",
      },
    ])
  })

  test("allows legacy ref with exclude_ref_patterns", () => {
    const toml = `
version = 1

[[environments]]
name = "main"

[[workspaces]]
path = "infra"
environments = ["main"]

[[triggers.github.push]]
ref = "refs/heads/main"
exclude_ref_patterns = ["refs/heads/main"]
environment = "main"
`

    const config = parseYaffleToml(toml)

    expect(config.triggers.github?.push).toEqual([
      {
        ref_patterns: ["refs/heads/main"],
        exclude_ref_patterns: ["refs/heads/main"],
        environment: "main",
      },
    ])
  })

  test("rejects push trigger with only exclude ref patterns", () => {
    const toml = `
version = 1

[[environments]]
name = "main"

[[workspaces]]
path = "infra"
environments = ["main"]

[[triggers.github.push]]
exclude_ref_patterns = ["refs/heads/main"]
environment = "main"
`

    expect(() => parseYaffleToml(toml)).toThrow(ConfigError)
    expect(() => parseYaffleToml(toml)).toThrow(/ref or ref_patterns/)
  })

  test("rejects push trigger with both ref and ref_patterns", () => {
    const toml = `
version = 1

[[environments]]
name = "main"

[[workspaces]]
path = "infra"
environments = ["main"]

[[triggers.github.push]]
ref = "refs/heads/main"
ref_patterns = ["refs/heads/release/**"]
environment = "main"
`

    expect(() => parseYaffleToml(toml)).toThrow(ConfigError)
    expect(() => parseYaffleToml(toml)).toThrow(/ref and ref_patterns/)
  })

  test("allows workspaces with no triggers (using '*' for PR environments)", () => {
    const toml = `
version = 1

[[workspaces]]
path = "infra"
environments = ["*"]

[[triggers.github.pull_request]]
branch_pattern = "*"
`

    const config = parseYaffleToml(toml)
    expect(config.workspaces).toHaveLength(1)
    expect(config.triggers.github?.pull_request).toHaveLength(1)
  })

  test("parses branch pattern arrays with excludes", () => {
    const toml = `
version = 1

[[workspaces]]
path = "infra"
environments = ["*"]

[[triggers.github.pull_request]]
branch_patterns = ["*"]
exclude_branch_patterns = ["dependabot/**"]
`

    const config = parseYaffleToml(toml)

    expect(config.triggers.github?.pull_request).toEqual([
      {
        branch_patterns: ["*"],
        exclude_branch_patterns: ["dependabot/**"],
      },
    ])
  })

  test("allows legacy branch_pattern with exclude_branch_patterns", () => {
    const toml = `
version = 1

[[workspaces]]
path = "infra"
environments = ["*"]

[[triggers.github.pull_request]]
branch_pattern = "*"
exclude_branch_patterns = ["dependabot/**"]
`

    const config = parseYaffleToml(toml)

    expect(config.triggers.github?.pull_request).toEqual([
      {
        branch_patterns: ["*"],
        exclude_branch_patterns: ["dependabot/**"],
      },
    ])
  })

  test("rejects pull request trigger with only exclude patterns", () => {
    const toml = `
version = 1

[[workspaces]]
path = "infra"
environments = ["*"]

[[triggers.github.pull_request]]
exclude_branch_patterns = ["dependabot/**"]
`

    expect(() => parseYaffleToml(toml)).toThrow(ConfigError)
    expect(() => parseYaffleToml(toml)).toThrow(/branch_pattern or branch_patterns/)
  })

  test("rejects pull request trigger with both branch_pattern and branch_patterns", () => {
    const toml = `
version = 1

[[workspaces]]
path = "infra"
environments = ["*"]

[[triggers.github.pull_request]]
branch_pattern = "*"
branch_patterns = ["main"]
`

    expect(() => parseYaffleToml(toml)).toThrow(ConfigError)
    expect(() => parseYaffleToml(toml)).toThrow(/branch_pattern and branch_patterns/)
  })

  test("handles invalid TOML syntax", () => {
    const toml = `
version = 1
workspaces = [
  { path = "infra", environments = ["*"]
]
`

    expect(() => parseYaffleToml(toml)).toThrow(ConfigError)
    expect(() => parseYaffleToml(toml)).toThrow(/Failed to parse yaffle.toml/)
  })
})

describe("matchBranchPattern", () => {
  test("exact match", () => {
    expect(matchBranchPattern("main", "main")).toBe(true)
    expect(matchBranchPattern("main", "staging")).toBe(false)
    expect(matchBranchPattern("main", "main2")).toBe(false)
  })

  test("wildcard '*' matches any string", () => {
    expect(matchBranchPattern("*", "main")).toBe(true)
    expect(matchBranchPattern("*", "feature/foo")).toBe(true)
    expect(matchBranchPattern("*", "")).toBe(true)
  })

  test("prefix wildcard", () => {
    expect(matchBranchPattern("feature/*", "feature/login")).toBe(true)
    expect(matchBranchPattern("feature/*", "feature/")).toBe(true)
    expect(matchBranchPattern("feature/*", "feature")).toBe(false)
    expect(matchBranchPattern("feature/*", "bugfix/login")).toBe(false)
  })

  test("suffix wildcard", () => {
    expect(matchBranchPattern("*/deploy", "staging/deploy")).toBe(true)
    expect(matchBranchPattern("*/deploy", "deploy")).toBe(false)
  })

  test("wildcard does not match path separator", () => {
    expect(matchBranchPattern("feature/*", "feature/login/v2")).toBe(false)
    expect(matchBranchPattern("release/*", "release/v1")).toBe(true)
    expect(matchBranchPattern("release/*", "release/v1/hotfix")).toBe(false)
  })

  test("double wildcard crosses path separators", () => {
    expect(matchBranchPattern("dependabot/**", "dependabot/npm_and_yarn/foo")).toBe(true)
    expect(matchBranchPattern("feature/**", "feature/login/v2")).toBe(true)
    expect(matchBranchPattern("feature/**", "bugfix/login")).toBe(false)
  })

  test("multiple wildcards", () => {
    expect(matchBranchPattern("*/fix/*", "bug/fix/login")).toBe(true)
    expect(matchBranchPattern("*/fix/*", "feature/fix/")).toBe(true)
    expect(matchBranchPattern("*/fix/*", "fix/login")).toBe(false)
  })
})

describe("findPushTriggerEnvironment", () => {
  const config = parseYaffleToml(`
version = 1

[[environments]]
name = "main"

[[environments]]
name = "staging"

[[environments]]
name = "release"

[[workspaces]]
path = "infra"
environments = ["main", "staging", "release"]

[[triggers.github.push]]
ref_patterns = ["refs/heads/main"]
environment = "main"

[[triggers.github.push]]
ref_patterns = ["refs/heads/staging"]
environment = "staging"

[[triggers.github.push]]
ref_patterns = ["refs/tags/v*"]
environment = "release"

[[triggers.github.push]]
ref_patterns = ["refs/heads/dependabot/**"]
exclude_ref_patterns = ["refs/heads/dependabot/**"]
environment = "main"
`)

  test("finds exact branch match", () => {
    expect(findPushTriggerEnvironment(config, "refs/heads/main")).toBe("main")
    expect(findPushTriggerEnvironment(config, "refs/heads/staging")).toBe("staging")
  })

  test("finds tag pattern match", () => {
    expect(findPushTriggerEnvironment(config, "refs/tags/v1")).toBe("release")
    expect(findPushTriggerEnvironment(config, "refs/tags/v1.0.0")).toBe("release")
  })

  test("returns undefined for no match", () => {
    expect(findPushTriggerEnvironment(config, "refs/heads/develop")).toBeUndefined()
    expect(findPushTriggerEnvironment(config, "refs/heads/feature/login")).toBeUndefined()
    expect(findPushTriggerEnvironment(config, "refs/tags/release-1")).toBeUndefined()
  })

  test("exclude patterns win over includes", () => {
    expect(findPushTriggerEnvironment(config, "refs/heads/dependabot/npm")).toBeUndefined()
  })
})

describe("matchRefPattern", () => {
  test("matches exact refs", () => {
    expect(matchRefPattern("refs/heads/main", "refs/heads/main")).toBe(true)
    expect(matchRefPattern("refs/tags/v1.0.0", "refs/tags/v1.0.0")).toBe(true)
    expect(matchRefPattern("refs/heads/main", "refs/heads/develop")).toBe(false)
  })

  test("matches tag patterns", () => {
    expect(matchRefPattern("refs/tags/v*", "refs/tags/v1")).toBe(true)
    expect(matchRefPattern("refs/tags/v*", "refs/tags/v1.0.0")).toBe(true)
    expect(matchRefPattern("refs/tags/v*", "refs/tags/release")).toBe(false)
  })

  test("matches branch patterns", () => {
    expect(matchRefPattern("refs/heads/feature/*", "refs/heads/feature/login")).toBe(true)
    expect(matchRefPattern("refs/heads/release/*", "refs/heads/release/v1")).toBe(true)
    expect(matchRefPattern("refs/heads/feature/*", "refs/heads/bugfix/crash")).toBe(false)
  })

  test("wildcard does not cross path segments", () => {
    expect(matchRefPattern("refs/tags/v*", "refs/tags/v1/beta")).toBe(false)
    expect(matchRefPattern("refs/heads/feature/*", "refs/heads/feature/a/b")).toBe(false)
  })

  test("double wildcard crosses path segments", () => {
    expect(matchRefPattern("refs/heads/feature/**", "refs/heads/feature/a/b")).toBe(true)
    expect(matchRefPattern("refs/tags/releases/**", "refs/tags/releases/v1/candidate")).toBe(true)
    expect(matchRefPattern("refs/heads/feature/**", "refs/heads/bugfix/a/b")).toBe(false)
  })
})

describe("matchesPullRequestTrigger", () => {
  const config = parseYaffleToml(`
version = 1

[[workspaces]]
path = "infra"
environments = ["*"]

[[triggers.github.pull_request]]
branch_patterns = ["feature/*", "bugfix/*"]
exclude_branch_patterns = ["feature/internal/**"]

`)

  test("matches feature branches", () => {
    expect(matchesPullRequestTrigger(config, "feature/login")).toBe(true)
    expect(matchesPullRequestTrigger(config, "feature/signup")).toBe(true)
  })

  test("matches bugfix branches", () => {
    expect(matchesPullRequestTrigger(config, "bugfix/crash")).toBe(true)
  })

  test("does not match other branches", () => {
    expect(matchesPullRequestTrigger(config, "main")).toBe(false)
    expect(matchesPullRequestTrigger(config, "release/v1")).toBe(false)
  })

  test("exclude patterns win over includes", () => {
    expect(matchesPullRequestTrigger(config, "feature/internal/dependabot")).toBe(false)
  })

  test("handles config with no PR triggers", () => {
    const noPrConfig = parseYaffleToml(`
version = 1

[[environments]]
name = "main"

[[workspaces]]
path = "infra"
environments = ["main"]

[[triggers.github.push]]
ref = "refs/heads/main"
environment = "main"
`)

    expect(matchesPullRequestTrigger(noPrConfig, "feature/login")).toBe(false)
  })
})

describe("getWorkspacesForEnvironment", () => {
  const config = parseYaffleToml(`
version = 1

[[environments]]
name = "main"

[[environments]]
name = "staging"

[[workspaces]]
path = "infra/shared"
environments = ["main", "staging"]

[[workspaces]]
path = "infra/production"
environments = ["main"]

[[workspaces]]
path = "apps/web/infra"
environments = ["*"]

[[triggers.github.push]]
ref = "refs/heads/main"
environment = "main"

[[triggers.github.push]]
ref = "refs/heads/staging"
environment = "staging"

[[triggers.github.pull_request]]
branch_pattern = "*"
`)

  test("returns workspaces for named environment (main)", () => {
    const workspaces = getWorkspacesForEnvironment(config, "main", false)
    expect(workspaces).toContain("infra/shared")
    expect(workspaces).toContain("infra/production")
    expect(workspaces).toContain("apps/web/infra")
    expect(workspaces).toHaveLength(3)
  })

  test("returns workspaces for named environment (staging)", () => {
    const workspaces = getWorkspacesForEnvironment(config, "staging", false)
    expect(workspaces).toContain("infra/shared")
    expect(workspaces).toContain("apps/web/infra")
    expect(workspaces).not.toContain("infra/production")
    expect(workspaces).toHaveLength(2)
  })

  test("returns only '*' workspaces for transient environments", () => {
    const workspaces = getWorkspacesForEnvironment(config, "pr-123", true)
    expect(workspaces).toContain("apps/web/infra")
    expect(workspaces).not.toContain("infra/shared")
    expect(workspaces).not.toContain("infra/production")
    expect(workspaces).toHaveLength(1)
  })
})

describe("PR environment name helpers", () => {
  test("buildPrEnvironmentName", () => {
    expect(buildPrEnvironmentName(1)).toBe("pr-1")
    expect(buildPrEnvironmentName(123)).toBe("pr-123")
    expect(buildPrEnvironmentName(99999)).toBe("pr-99999")
  })

  test("parsePrEnvironmentName", () => {
    expect(parsePrEnvironmentName("pr-1")).toBe(1)
    expect(parsePrEnvironmentName("pr-123")).toBe(123)
    expect(parsePrEnvironmentName("pr-99999")).toBe(99999)
  })

  test("parsePrEnvironmentName returns undefined for invalid names", () => {
    expect(parsePrEnvironmentName("main")).toBeUndefined()
    expect(parsePrEnvironmentName("staging")).toBeUndefined()
    expect(parsePrEnvironmentName("pr-")).toBeUndefined()
    expect(parsePrEnvironmentName("pr-abc")).toBeUndefined()
    expect(parsePrEnvironmentName("")).toBeUndefined()
  })
})

describe("workspace variables", () => {
  test("parses string variables", () => {
    const toml = `
version = 1

[[workspaces]]
path = "infra"
environments = ["*"]
variables.domain = "example.com"
variables.region = "us-east-1"
`
    const config = parseYaffleToml(toml)
    expect(config.workspaces[0].variables).toEqual({
      domain: "example.com",
      region: "us-east-1",
    })
  })

  test("parses number variables", () => {
    const toml = `
version = 1

[[workspaces]]
path = "infra"
environments = ["*"]
variables.replicas = 3
variables.timeout = 30.5
`
    const config = parseYaffleToml(toml)
    expect(config.workspaces[0].variables).toEqual({
      replicas: 3,
      timeout: 30.5,
    })
  })

  test("parses boolean variables", () => {
    const toml = `
version = 1

[[workspaces]]
path = "infra"
environments = ["*"]
variables.enabled = true
variables.debug = false
`
    const config = parseYaffleToml(toml)
    expect(config.workspaces[0].variables).toEqual({
      enabled: true,
      debug: false,
    })
  })

  test("parses mixed type variables", () => {
    const toml = `
version = 1

[[workspaces]]
path = "infra"
environments = ["*"]

[workspaces.variables]
name = "my-app"
replicas = 3
enabled = true
`
    const config = parseYaffleToml(toml)
    expect(config.workspaces[0].variables).toEqual({
      name: "my-app",
      replicas: 3,
      enabled: true,
    })
  })

  test("parses inline table syntax", () => {
    const toml = `
version = 1

[[workspaces]]
path = "infra"
environments = ["*"]
variables = { domain = "example.com", port = 8080 }
`
    const config = parseYaffleToml(toml)
    expect(config.workspaces[0].variables).toEqual({
      domain: "example.com",
      port: 8080,
    })
  })

  test("allows workspaces without variables", () => {
    const toml = `
version = 1

[[workspaces]]
path = "infra"
environments = ["*"]
`
    const config = parseYaffleToml(toml)
    expect(config.workspaces[0].variables).toBeUndefined()
  })
})

describe("workspace outputs", () => {
  test("parses workspace output policies", () => {
    const toml = `
version = 1

[[workspaces]]
path = "platform/eks"
environments = ["*"]

outputs.cluster_endpoint = { visibility = "public", consumers = ["acme:yaffle-dot-dev/apps:apps/*"] }
outputs.cluster_ca = { visibility = "public", consumers = ["acme:yaffle-dot-dev/apps:apps/*"] }
outputs.secret_arn = { visibility = "internal" }
`

    const config = parseYaffleToml(toml)
    expect(config.workspaces[0].outputs).toEqual({
      cluster_endpoint: {
        visibility: "public",
        consumers: ["acme:yaffle-dot-dev/apps:apps/*"],
      },
      cluster_ca: {
        visibility: "public",
        consumers: ["acme:yaffle-dot-dev/apps:apps/*"],
      },
      secret_arn: {
        visibility: "internal",
      },
    })
  })

  test("rejects public output policies without consumers", () => {
    const toml = `
version = 1

[[workspaces]]
path = "platform/eks"
environments = ["*"]

outputs.cluster_endpoint = { visibility = "public" }
`

    expect(() => parseYaffleToml(toml)).toThrow(/public output policy for "cluster_endpoint" must declare at least one consumer selector/)
  })

  test("rejects internal output policies with consumers", () => {
    const toml = `
version = 1

[[workspaces]]
path = "platform/eks"
environments = ["*"]

outputs.cluster_endpoint = { visibility = "internal", consumers = ["acme:yaffle-dot-dev/apps:apps/*"] }
`

    expect(() => parseYaffleToml(toml)).toThrow(/internal output policy for "cluster_endpoint" cannot declare consumers/)
  })

  test("rejects unsupported [[workspaces.exports]] syntax", () => {
    const toml = `
version = 1

[[workspaces]]
path = "platform/eks"
environments = ["*"]

[[workspaces.exports]]
outputs = ["cluster_endpoint"]
visibility = "public"
consumers = ["acme:yaffle-dot-dev/apps:apps/*"]
`

    expect(() => parseYaffleToml(toml)).toThrow("uses unsupported [[workspaces.exports]] syntax")
  })

  test("rejects slash-delimited consumer selectors", () => {
    const toml = `
version = 1

[[workspaces]]
path = "platform/eks"
environments = ["*"]

outputs.cluster_endpoint = { visibility = "public", consumers = ["apps:apps/*"] }
`

    expect(() => parseYaffleToml(toml)).toThrow(/invalid consumer selector/)
  })
})

describe("matchWorkspacePattern", () => {
  test("exact match", () => {
    expect(matchWorkspacePattern("infra/shared", "infra/shared")).toBe(true)
    expect(matchWorkspacePattern("infra/shared", "infra/production")).toBe(false)
  })

  test("wildcard matches everything", () => {
    expect(matchWorkspacePattern("*", "infra/shared")).toBe(true)
    expect(matchWorkspacePattern("*", "apps/web/infra")).toBe(true)
    expect(matchWorkspacePattern("*", "")).toBe(true)
  })

  test("prefix wildcard matches multiple segments", () => {
    expect(matchWorkspacePattern("infra/*", "infra/shared")).toBe(true)
    expect(matchWorkspacePattern("infra/*", "infra/shared/deep/nested")).toBe(true)
    expect(matchWorkspacePattern("infra/*", "infra")).toBe(false)
    expect(matchWorkspacePattern("infra/*", "apps/infra")).toBe(false)
  })

  test("middle wildcard matches multiple segments", () => {
    expect(matchWorkspacePattern("infra/*/production", "infra/shared/production")).toBe(true)
    expect(matchWorkspacePattern("infra/*/production", "infra/a/b/c/production")).toBe(true)
    expect(matchWorkspacePattern("infra/*/production", "infra/production")).toBe(false)
    expect(matchWorkspacePattern("infra/*/production", "infra/shared/staging")).toBe(false)
  })

  test("suffix wildcard", () => {
    expect(matchWorkspacePattern("*/infra", "apps/web/infra")).toBe(true)
    expect(matchWorkspacePattern("*/infra", "infra")).toBe(false)
  })

  test("multiple wildcards", () => {
    expect(matchWorkspacePattern("apps/*/infra/*", "apps/web/infra/production")).toBe(true)
    expect(matchWorkspacePattern("apps/*/infra/*", "apps/a/b/infra/c/d")).toBe(true)
  })
})

describe("consumer selectors", () => {
  test("parses consumer selector format", () => {
    expect(parseConsumerSelector("acme:yaffle-dot-dev/yaffle:apps/*")).toEqual({
      orgPattern: "acme",
      repoPattern: "yaffle-dot-dev/yaffle",
      workspacePattern: "apps/*",
    })
  })

  test("returns null for invalid selector format", () => {
    expect(parseConsumerSelector("platform")).toBeNull()
    expect(parseConsumerSelector("acme:platform")).toBeNull()
    expect(parseConsumerSelector(":platform:apps/*")).toBeNull()
    expect(parseConsumerSelector("acme::apps/*")).toBeNull()
    expect(parseConsumerSelector("acme:platform:")).toBeNull()
  })

  test("matches consumer selectors with workspace globs", () => {
    expect(matchConsumerSelector("acme:yaffle-dot-dev/yaffle:apps/*", {
      org: "acme",
      repo: "yaffle-dot-dev/yaffle",
      workspacePath: "apps/api/infra",
    })).toBe(true)

    expect(matchConsumerSelector("acme:yaffle-dot-dev/yaffle:apps/*", {
      org: "acme",
      repo: "yaffle-dot-dev/yaffle",
      workspacePath: "services/worker/infra",
    })).toBe(false)
  })

  test("supports wildcards in org and repo segments", () => {
    expect(matchConsumerSelector("acme-*:yaffle-dot-dev/*:apps/*", {
      org: "acme-prod",
      repo: "yaffle-dot-dev/yaffle",
      workspacePath: "apps/web/infra",
    })).toBe(true)
  })

  test("supports exact repo matching", () => {
    expect(matchConsumerSelector("acme:yaffle-dot-dev/yaffle:apps/*", {
      org: "other-org",
      repo: "other-platform/yaffle",
      workspacePath: "apps/web/infra",
    })).toBe(false)
  })
})

describe("approvals", () => {
  test("parses approval rules", () => {
    const toml = `
version = 1

[[environments]]
name = "main"

[[workspaces]]
path = "infra/production"
environments = ["main"]

[[triggers.github.push]]
ref = "refs/heads/main"
environment = "main"

[[approvals]]
workspaces = ["infra/production"]
environments = ["main"]
approvers = ["github:user:alice", "github:user:bob"]
`
    const config = parseYaffleToml(toml)
    expect(config.approvals).toHaveLength(1)
    expect(config.approvals[0]).toEqual({
      workspaces: ["infra/production"],
      environments: ["main"],
      approvers: ["github:user:alice", "github:user:bob"],
    })
  })

  test("allows empty approvers array (no approval required)", () => {
    const toml = `
version = 1

[[workspaces]]
path = "infra"
environments = ["*"]

[[approvals]]
workspaces = ["infra"]
environments = ["*"]
approvers = []
`
    const config = parseYaffleToml(toml)
    expect(config.approvals[0].approvers).toEqual([])
  })

  test("allows multiple approval rules", () => {
    const toml = `
version = 1

[[environments]]
name = "main"

[[workspaces]]
path = "infra/production"
environments = ["main"]

[[workspaces]]
path = "infra/staging"
environments = ["main"]

[[triggers.github.push]]
ref = "refs/heads/main"
environment = "main"

[[approvals]]
workspaces = ["infra/production"]
environments = ["main"]
approvers = ["github:user:alice"]

[[approvals]]
workspaces = ["infra/*"]
environments = ["*"]
approvers = ["github:user:bob"]
`
    const config = parseYaffleToml(toml)
    expect(config.approvals).toHaveLength(2)
  })

  test("allows config with no approvals", () => {
    const toml = `
version = 1

[[workspaces]]
path = "infra"
environments = ["*"]
`
    const config = parseYaffleToml(toml)
    expect(config.approvals).toEqual([])
  })
})

describe("resolveApprovers", () => {
  const config = parseYaffleToml(`
version = 1

[[environments]]
name = "main"

[[environments]]
name = "staging"

[[workspaces]]
path = "infra/production"
environments = ["main"]

[[workspaces]]
path = "infra/staging"
environments = ["staging"]

[[workspaces]]
path = "apps/web/infra"
environments = ["*"]

[[triggers.github.push]]
ref = "refs/heads/main"
environment = "main"

[[triggers.github.push]]
ref = "refs/heads/staging"
environment = "staging"

[[approvals]]
workspaces = ["infra/production"]
environments = ["main"]
approvers = ["github:user:alice", "github:user:bob"]

[[approvals]]
workspaces = ["infra/*"]
environments = ["main"]
approvers = ["github:user:carol"]

[[approvals]]
workspaces = ["apps/*"]
environments = ["*"]
approvers = ["github:user:dave"]
`)

  test("returns approvers for exact workspace match", () => {
    const approvers = resolveApprovers(config, "infra/production", "main")
    // Matches both "infra/production" and "infra/*" rules
    expect(approvers).toContain("github:user:alice")
    expect(approvers).toContain("github:user:bob")
    expect(approvers).toContain("github:user:carol")
    expect(approvers).toHaveLength(3)
  })

  test("returns approvers for glob workspace match", () => {
    const approvers = resolveApprovers(config, "infra/staging", "main")
    // Only matches "infra/*" rule (environment is main)
    expect(approvers).toEqual(["github:user:carol"])
  })

  test("returns approvers for wildcard environment match", () => {
    const approvers = resolveApprovers(config, "apps/web/infra", "pr-123")
    // Matches "apps/*" with environments = ["*"]
    expect(approvers).toEqual(["github:user:dave"])
  })

  test("returns empty array when no rules match", () => {
    const approvers = resolveApprovers(config, "infra/staging", "staging")
    // No rule matches infra/* with staging environment
    expect(approvers).toEqual([])
  })

  test("returns unique approvers (no duplicates)", () => {
    // Create a config with overlapping rules that have the same approver
    const overlappingConfig = parseYaffleToml(`
version = 1

[[environments]]
name = "main"

[[workspaces]]
path = "infra/shared"
environments = ["main"]

[[triggers.github.push]]
ref = "refs/heads/main"
environment = "main"

[[approvals]]
workspaces = ["infra/shared"]
environments = ["main"]
approvers = ["github:user:alice", "github:user:bob"]

[[approvals]]
workspaces = ["infra/*"]
environments = ["main"]
approvers = ["github:user:alice", "github:user:carol"]
`)
    const approvers = resolveApprovers(overlappingConfig, "infra/shared", "main")
    expect(approvers).toContain("github:user:alice")
    expect(approvers).toContain("github:user:bob")
    expect(approvers).toContain("github:user:carol")
    expect(approvers).toHaveLength(3) // alice not duplicated
  })
})

describe("isApprovalRequired", () => {
  const config = parseYaffleToml(`
version = 1

[[environments]]
name = "main"

[[workspaces]]
path = "infra/production"
environments = ["main"]

[[workspaces]]
path = "infra/dev"
environments = ["main"]

[[triggers.github.push]]
ref = "refs/heads/main"
environment = "main"

[[approvals]]
workspaces = ["infra/production"]
environments = ["main"]
approvers = ["github:user:alice"]

[[approvals]]
workspaces = ["infra/dev"]
environments = ["main"]
approvers = []
`)

  test("returns true when approvers exist", () => {
    expect(isApprovalRequired(config, "infra/production", "main")).toBe(true)
  })

  test("returns false when approvers array is empty", () => {
    expect(isApprovalRequired(config, "infra/dev", "main")).toBe(false)
  })

  test("returns false when no rules match", () => {
    expect(isApprovalRequired(config, "apps/web", "main")).toBe(false)
  })
})

describe("validateWorkspacePaths", () => {
  test("returns empty array when all paths exist", async () => {
    const config = parseYaffleToml(`
version = 1

[[workspaces]]
path = "infra/shared"
environments = ["*"]

[[workspaces]]
path = "apps/web/infra"
environments = ["*"]
`)
    const pathExists = async (path: string) => ["infra/shared", "apps/web/infra"].includes(path)
    const errors = await validateWorkspacePaths(config, pathExists)
    expect(errors).toEqual([])
  })

  test("returns errors for missing paths", async () => {
    const config = parseYaffleToml(`
version = 1

[[workspaces]]
path = "infra/shared"
environments = ["*"]

[[workspaces]]
path = "infra/missing"
environments = ["*"]

[[workspaces]]
path = "apps/web/infra"
environments = ["*"]
`)
    const pathExists = async (path: string) => ["infra/shared", "apps/web/infra"].includes(path)
    const errors = await validateWorkspacePaths(config, pathExists)
    expect(errors).toHaveLength(1)
    expect(errors[0].path).toBe("infra/missing")
    expect(errors[0].message).toContain("does not exist")
  })

  test("returns multiple errors for multiple missing paths", async () => {
    const config = parseYaffleToml(`
version = 1

[[workspaces]]
path = "missing1"
environments = ["*"]

[[workspaces]]
path = "missing2"
environments = ["*"]
`)
    const pathExists = async () => false
    const errors = await validateWorkspacePaths(config, pathExists)
    expect(errors).toHaveLength(2)
    expect(errors.map((e) => e.path)).toContain("missing1")
    expect(errors.map((e) => e.path)).toContain("missing2")
  })
})
