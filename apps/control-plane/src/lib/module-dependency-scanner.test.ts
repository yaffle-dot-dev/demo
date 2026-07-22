import { describe, it, expect } from "@yaffle/test"

import {
  extractDependenciesFromContent,
  extractYaffleModuleOutputReferencesFromContent,
  moduleNameToWorkspacePath,
  workspacePathToModuleName,
} from "@yaffle/shared"

describe("moduleNameToWorkspacePath", () => {
  it("converts module names to workspace paths", () => {
    expect(moduleNameToWorkspacePath("apps--web--infra")).toBe("apps/web/infra")
    expect(moduleNameToWorkspacePath("infra--shared")).toBe("infra/shared")
    expect(moduleNameToWorkspacePath("single")).toBe("single")
  })
})

describe("workspacePathToModuleName", () => {
  it("converts workspace paths to module names", () => {
    expect(workspacePathToModuleName("apps/web/infra")).toBe("apps--web--infra")
    expect(workspacePathToModuleName("infra/shared")).toBe("infra--shared")
    expect(workspacePathToModuleName("single")).toBe("single")
  })
})

describe("extractDependenciesFromContent", () => {
  it("extracts single module dependency", () => {
    const content = `
module "shared" {
  source = "yaffle.local:6969/yaffle-dot-dev--yaffle/infra--shared/yaffle"
}
`
    const deps = extractDependenciesFromContent(content)
    expect(deps).toEqual(["infra/shared"])
  })

  it("extracts multiple module dependencies", () => {
    const content = `
module "shared" {
  source = "yaffle.local:6969/yaffle-dot-dev--yaffle/infra--shared/yaffle"
}

module "production" {
  source = "yaffle.local:6969/yaffle-dot-dev--yaffle/infra--production/yaffle"
}

    module "web" {
      source = "yaffle.local:6969/org-name--repo/apps--web--infra/yaffle"
    }
`
    const deps = extractDependenciesFromContent(content)
    expect(deps.sort()).toEqual(["apps/web/infra", "infra/production", "infra/shared"])
  })

  it("ignores non-yaffle module sources", () => {
    const content = `
module "vpc" {
  source = "terraform-aws-modules/vpc/aws"
  version = "5.0.0"
}

module "shared" {
  source = "yaffle.local:6969/org--repo/infra--shared/yaffle"
}

module "s3" {
  source = "./modules/s3"
}
`
    const deps = extractDependenciesFromContent(content)
    expect(deps).toEqual(["infra/shared"])
  })

  it("handles different port numbers", () => {
    const content = `
module "shared" {
  source = "yaffle.local:8080/org--repo/infra--shared/yaffle"
}
`
    const deps = extractDependenciesFromContent(content)
    expect(deps).toEqual(["infra/shared"])
  })

  it("handles tailscale hostnames", () => {
    const content = `
module "shared" {
  source = "yaffle.tail66f312.ts.net:6969/org--repo/infra--shared/yaffle"
}
`
    const deps = extractDependenciesFromContent(content)
    expect(deps).toEqual(["infra/shared"])
  })

  it("handles production hostname without explicit port", () => {
    const content = `
module "shared" {
  source = "yaffle.dev/org--repo/infra--shared/yaffle"
}
`
    const deps = extractDependenciesFromContent(content)
    expect(deps).toEqual(["infra/shared"])
  })

  it("resolves variable defaults in module sources", () => {
    const content = `
variable "registry_host" {
  default = "yaffle.dev"
}

module "shared" {
  source = "\${var.registry_host}/org--repo/infra--shared/yaffle"
}
`
    const deps = extractDependenciesFromContent(content)
    expect(deps).toEqual(["infra/shared"])
  })

  it("resolves locals referenced by module sources", () => {
    const content = `
variable "registry_host" {
  default = "yaffle.dev"
}

locals {
  selected_host = var.registry_host
}

module "shared" {
  source = "\${local.selected_host}/org--repo/infra--shared/yaffle"
}
`
    const deps = extractDependenciesFromContent(content)
    expect(deps).toEqual(["infra/shared"])
  })

  it("uses bound variable context from yaffle config", () => {
    const content = `
variable "registry_host" {}

module "shared" {
  source = "\${var.registry_host}/org--repo/infra--shared/yaffle"
}
`
    const deps = extractDependenciesFromContent(content, {
      variables: {
        registry_host: "yaffle.dev",
      },
    })
    expect(deps).toEqual(["infra/shared"])
  })

  it("filters dependencies to the current namespace when provided", () => {
    const content = `
module "same_repo" {
  source = "yaffle.dev/yaffle-dot-dev--platform/core--network/yaffle"
}

module "cross_repo" {
  source = "yaffle.dev/yaffle-dot-dev--applications/core--network/yaffle"
}
`

    const deps = extractDependenciesFromContent(content, {
      currentNamespace: "yaffle-dot-dev--platform",
    })

    expect(deps).toEqual(["core/network"])
  })

  it("keeps existing behavior when current namespace is not provided", () => {
    const content = `
module "platform" {
  source = "yaffle.dev/yaffle-dot-dev--platform/infra--shared/yaffle"
}

module "apps" {
  source = "yaffle.dev/yaffle-dot-dev--applications/apps--shared/yaffle"
}
`

    const deps = extractDependenciesFromContent(content)

    expect(deps.sort()).toEqual(["apps/shared", "infra/shared"])
  })

  it("prefers bound variables over terraform defaults", () => {
    const content = `
variable "registry_host" {
  default = "evil.example.com"
}

module "shared" {
  source = "\${var.registry_host}/org--repo/infra--shared/yaffle"
}
`
    const deps = extractDependenciesFromContent(content, {
      variables: {
        registry_host: "yaffle.dev",
      },
    })
    expect(deps).toEqual(["infra/shared"])
  })

  it("ignores non-allowlisted hosts", () => {
    const content = `
module "shared" {
  source = "evil.example.com/org--repo/infra--shared/yaffle"
}
`
    const deps = extractDependenciesFromContent(content)
    expect(deps).toEqual([])
  })

  it("supports env override for allowed hosts", () => {
    const original = process.env.YAFFLE_MODULE_SOURCE_ALLOWED_HOSTS
    process.env.YAFFLE_MODULE_SOURCE_ALLOWED_HOSTS = "custom.example.com"

    const content = `
module "shared" {
  source = "custom.example.com/org--repo/infra--shared/yaffle"
}
`
    const deps = extractDependenciesFromContent(content)

    if (original === undefined) {
      delete process.env.YAFFLE_MODULE_SOURCE_ALLOWED_HOSTS
    } else {
      process.env.YAFFLE_MODULE_SOURCE_ALLOWED_HOSTS = original
    }

    expect(deps).toEqual(["infra/shared"])
  })

  it("returns empty array for no dependencies", () => {
    const content = `
resource "aws_s3_bucket" "main" {
  bucket = "my-bucket"
}
`
    const deps = extractDependenciesFromContent(content)
    expect(deps).toEqual([])
  })

  it("handles conditional module blocks", () => {
    const content = `
module "main" {
  count  = var.is_preview ? 0 : 1
  source = "yaffle.local:6969/org--repo/infra--production/yaffle"
}

module "nonprod" {
  count  = var.is_preview ? 1 : 0
  source = "yaffle.local:6969/org--repo/infra--nonprod/yaffle"
}
`
    const deps = extractDependenciesFromContent(content)
    // Should extract both since either could be active
    expect(deps).toEqual(["infra/production", "infra/nonprod"])
  })

  it("handles nested paths", () => {
    const content = `
module "deep" {
  source = "yaffle.local:6969/org--repo/a--b--c--d--e/yaffle"
}
`
    const deps = extractDependenciesFromContent(content)
    expect(deps).toEqual(["a/b/c/d/e"])
  })

  it("handles whitespace variations", () => {
    const content = `
module "ws1" {
  source="yaffle.local:6969/org--repo/infra--a/yaffle"
}

module "ws2" {
  source  =  "yaffle.local:6969/org--repo/infra--b/yaffle"
}
`
    const deps = extractDependenciesFromContent(content)
    expect(deps).toContain("infra/a")
    expect(deps).toContain("infra/b")
  })
})

describe("extractYaffleModuleOutputReferencesFromContent", () => {
  it("associates referenced outputs with their producer workspace", () => {
    const references = extractYaffleModuleOutputReferencesFromContent(`
module "shared" {
  source = "yaffle.dev/org--repo/infra--shared/yaffle"
}

locals {
  zone_id = module.shared.route53_zone_id
  price   = module.shared.stripe_pricing.pro.price_id
  copy    = module.shared.route53_zone_id
  both    = [module.shared.route53_zone_id, module.shared.stripe_pricing]
}
`)

    expect(references).toEqual([
      {
        moduleName: "shared",
        producerWorkspacePath: "infra/shared",
        outputName: "route53_zone_id",
      },
      {
        moduleName: "shared",
        producerWorkspacePath: "infra/shared",
        outputName: "stripe_pricing",
      },
    ])
  })

  it("supports indexed module instances and ignores non-Yaffle modules", () => {
    const references = extractYaffleModuleOutputReferencesFromContent(`
module "core" {
  source = "yaffle.dev/org--repo/infra--production/yaffle"
}

module "external" {
  source = "terraform-aws-modules/vpc/aws"
}

locals {
  cluster = module.core[0].ecs_cluster_arn
  ignored = module.external.vpc_id
}
`)

    expect(references).toEqual([
      {
        moduleName: "core",
        producerWorkspacePath: "infra/production",
        outputName: "ecs_cluster_arn",
      },
    ])
  })

  it("finds output references inside nested collection expressions", () => {
    const references = extractYaffleModuleOutputReferencesFromContent(`
module "runner" {
  source = "yaffle.dev/org--repo/apps--runner--infra/yaffle"
}

resource "example" "control_plane" {
  config = jsonencode([
    {
      environment = [
        { name = "BEFORE", value = "before" },
        { name = "YAFFLE_ECS_SECURITY_GROUPS", value = module.runner.security_group_id },
      ]
    }
  ])
}
`)

    expect(references).toEqual([
      {
        moduleName: "runner",
        producerWorkspacePath: "apps/runner/infra",
        outputName: "security_group_id",
      },
    ])
  })
})
