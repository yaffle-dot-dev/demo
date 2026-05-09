import { describe, expect, it } from "@yaffle/test"
import {
  renderTemplate,
  renderVariables,
  TemplateError,
  type TemplateContext,
} from "./templating.ts"

/**
 * Helper to create a full template context.
 */
function makeContext(overrides: Partial<TemplateContext> = {}): TemplateContext {
  return {
    environment: "main",
    environment_kind: "named",
    org: "acme",
    repo: "webapp",
    workspace_path: "infra/production",
    branch: "main",
    commit_sha: "abc123def456",
    pr_number: null,
    ...overrides,
  }
}

describe("renderTemplate", () => {
  describe("basic substitution", () => {
    it("renders simple variable", () => {
      const ctx = makeContext()
      const result = renderTemplate("{{ environment }}", ctx, {
        workspacePath: "infra",
        variableName: "test",
      })
      expect(result).toBe("main")
    })

    it("renders multiple variables", () => {
      const ctx = makeContext({ org: "myorg", repo: "myrepo" })
      const result = renderTemplate("{{ org }}/{{ repo }}", ctx, {
        workspacePath: "infra",
        variableName: "test",
      })
      expect(result).toBe("myorg/myrepo")
    })

    it("renders variable in larger string", () => {
      const ctx = makeContext({ environment: "staging" })
      const result = renderTemplate("https://{{ environment }}.yaffle.dev", ctx, {
        workspacePath: "infra",
        variableName: "domain",
      })
      expect(result).toBe("https://staging.yaffle.dev")
    })

    it("passes through strings without template syntax", () => {
      const ctx = makeContext()
      const result = renderTemplate("plain string value", ctx, {
        workspacePath: "infra",
        variableName: "test",
      })
      expect(result).toBe("plain string value")
    })

    it("renders all context variables", () => {
      const ctx = makeContext({
        environment: "pr-123",
        environment_kind: "transient",
        org: "testorg",
        repo: "testrepo",
        workspace_path: "infra/staging",
        branch: "feature/test",
        commit_sha: "deadbeef",
        pr_number: 123,
      })

      expect(renderTemplate("{{ environment }}", ctx, { workspacePath: "x", variableName: "a" })).toBe("pr-123")
      expect(renderTemplate("{{ environment_kind }}", ctx, { workspacePath: "x", variableName: "b" })).toBe("transient")
      expect(renderTemplate("{{ org }}", ctx, { workspacePath: "x", variableName: "c" })).toBe("testorg")
      expect(renderTemplate("{{ repo }}", ctx, { workspacePath: "x", variableName: "d" })).toBe("testrepo")
      expect(renderTemplate("{{ workspace_path }}", ctx, { workspacePath: "x", variableName: "e" })).toBe("infra/staging")
      expect(renderTemplate("{{ branch }}", ctx, { workspacePath: "x", variableName: "f" })).toBe("feature/test")
      expect(renderTemplate("{{ commit_sha }}", ctx, { workspacePath: "x", variableName: "g" })).toBe("deadbeef")
      expect(renderTemplate("{{ pr_number }}", ctx, { workspacePath: "x", variableName: "h" })).toBe("123")
    })

    it("renders null pr_number for named environments", () => {
      const ctx = makeContext({ pr_number: null })
      // MiniJinja renders null as "none" by default
      const result = renderTemplate("PR: {{ pr_number }}", ctx, {
        workspacePath: "infra",
        variableName: "test",
      })
      expect(result).toBe("PR: none")
    })
  })

  describe("jinja filters and expressions", () => {
    it("supports lower filter", () => {
      const ctx = makeContext({ environment: "PRODUCTION" })
      const result = renderTemplate("{{ environment | lower }}", ctx, {
        workspacePath: "infra",
        variableName: "test",
      })
      expect(result).toBe("production")
    })

    it("supports upper filter", () => {
      const ctx = makeContext({ environment: "production" })
      const result = renderTemplate("{{ environment | upper }}", ctx, {
        workspacePath: "infra",
        variableName: "test",
      })
      expect(result).toBe("PRODUCTION")
    })

    it("supports replace filter", () => {
      const ctx = makeContext({ branch: "feature/test-branch" })
      const result = renderTemplate("{{ branch | replace('/', '-') }}", ctx, {
        workspacePath: "infra",
        variableName: "test",
      })
      expect(result).toBe("feature-test-branch")
    })

    it("supports default filter", () => {
      const ctx = makeContext({ pr_number: null })
      const result = renderTemplate("{{ pr_number | default('none') }}", ctx, {
        workspacePath: "infra",
        variableName: "test",
      })
      expect(result).toBe("none")
    })

    it("supports conditionals", () => {
      const ctx = makeContext({ environment_kind: "transient", pr_number: 42 })
      const result = renderTemplate(
        "{% if environment_kind == 'transient' %}preview-{{ pr_number }}{% else %}prod{% endif %}",
        ctx,
        { workspacePath: "infra", variableName: "test" },
      )
      expect(result).toBe("preview-42")
    })
  })

  describe("error handling", () => {
    it("throws TemplateError on undefined variable", () => {
      const ctx = makeContext()
      expect(() => {
        renderTemplate("{{ undefined_var }}", ctx, {
          workspacePath: "infra/prod",
          variableName: "bad_var",
        })
      }).toThrow(TemplateError)
    })

    it("includes workspace path in error", () => {
      const ctx = makeContext()
      try {
        renderTemplate("{{ undefined_var }}", ctx, {
          workspacePath: "infra/prod",
          variableName: "bad_var",
        })
        expect.unreachable("should have thrown")
      } catch (err) {
        expect(err).toBeInstanceOf(TemplateError)
        const templateErr = err as TemplateError
        expect(templateErr.workspacePath).toBe("infra/prod")
        expect(templateErr.variableName).toBe("bad_var")
        expect(templateErr.message).toContain("infra/prod")
        expect(templateErr.message).toContain("bad_var")
      }
    })

    it("throws TemplateError on syntax error", () => {
      const ctx = makeContext()
      expect(() => {
        renderTemplate("{{ unclosed", ctx, {
          workspacePath: "infra",
          variableName: "broken",
        })
      }).toThrow(TemplateError)
    })
  })
})

describe("renderVariables", () => {
  it("renders all string variables", () => {
    const ctx = makeContext({ environment: "staging", org: "myorg" })
    const variables = {
      domain: "{{ environment }}.example.com",
      api_url: "https://api.{{ org }}.io",
    }

    const result = renderVariables(variables, ctx, "infra/web")

    expect(result).toEqual({
      domain: "staging.example.com",
      api_url: "https://api.myorg.io",
    })
  })

  it("passes through boolean values unchanged", () => {
    const ctx = makeContext()
    const variables = {
      enabled: true,
      debug: false,
    }

    const result = renderVariables(variables, ctx, "infra")

    expect(result).toEqual({
      enabled: true,
      debug: false,
    })
  })

  it("passes through number values unchanged", () => {
    const ctx = makeContext()
    const variables = {
      replicas: 3,
      port: 8080,
      timeout: 30.5,
    }

    const result = renderVariables(variables, ctx, "infra")

    expect(result).toEqual({
      replicas: 3,
      port: 8080,
      timeout: 30.5,
    })
  })

  it("handles mixed variable types", () => {
    const ctx = makeContext({ environment: "prod", org: "acme" })
    const variables = {
      name: "{{ org }}-{{ environment }}",
      enabled: true,
      replicas: 5,
      version: "1.0.0",
    }

    const result = renderVariables(variables, ctx, "infra")

    expect(result).toEqual({
      name: "acme-prod",
      enabled: true,
      replicas: 5,
      version: "1.0.0",
    })
  })

  it("returns empty object for empty input", () => {
    const ctx = makeContext()
    const result = renderVariables({}, ctx, "infra")
    expect(result).toEqual({})
  })

  it("throws TemplateError with workspace path on failure", () => {
    const ctx = makeContext()
    const variables = {
      good: "{{ environment }}",
      bad: "{{ nonexistent }}",
    }

    expect(() => {
      renderVariables(variables, ctx, "infra/broken")
    }).toThrow(TemplateError)

    try {
      renderVariables(variables, ctx, "infra/broken")
      expect.unreachable("should have thrown")
    } catch (err) {
      expect(err).toBeInstanceOf(TemplateError)
      const templateErr = err as TemplateError
      expect(templateErr.workspacePath).toBe("infra/broken")
      expect(templateErr.variableName).toBe("bad")
    }
  })
})
