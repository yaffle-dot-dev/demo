import { readFileSync, readdirSync } from "node:fs"
import { join, relative } from "node:path"

import { afterAll, beforeAll, describe, expect, test, vi } from "@yaffle/test"

import { parseYaffleToml } from "../apps/control-plane/src/lib/config-toml"

const REPO_ROOT = join(import.meta.dirname, "..")
const PUBLIC_DOC_ROOT = join(REPO_ROOT, "apps/docs/src/content/docs")

function markdownFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return markdownFiles(path)
    return entry.name.endsWith(".md") || entry.name.endsWith(".mdx") ? [path] : []
  })
}

function tomlExamples(path: string): string[] {
  const markdown = readFileSync(path, "utf8")
  return [...markdown.matchAll(/^\s*```toml\s*$([\s\S]*?)^\s*```\s*$/gm)].map((match) =>
    match[1]
      .split("\n")
      .map((line) => line.replace(/^\s{3}/, ""))
      .join("\n")
      .trim(),
  )
}

function completeConfigSnippet(toml: string): string {
  if (toml.includes("[[workspaces]]")) return toml

  return `${toml}

[[workspaces]]
path = "infra/example"
environments = ["*"]`
}

describe("public yaffle.toml examples", () => {
  beforeAll(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
  })

  afterAll(() => {
    vi.restoreAllMocks()
  })

  const examples = markdownFiles(PUBLIC_DOC_ROOT).flatMap((path) =>
    tomlExamples(path).map((toml, index) => ({
      name: `${relative(PUBLIC_DOC_ROOT, path)} example ${index + 1}`,
      toml,
    })),
  )

  test("documents at least one configuration", () => {
    expect(examples.length).toBeGreaterThan(0)
  })

  test.each(examples)("$name validates against the canonical schema", ({ toml }) => {
    expect(toml).toMatch(/^version = 1$/m)
    expect(() => parseYaffleToml(completeConfigSnippet(toml))).not.toThrow()
  })

  test("the published demo validates against the canonical schema", () => {
    const demo = readFileSync(join(import.meta.dirname, "../demo/yaffle.toml"), "utf8")
    expect(() => parseYaffleToml(demo)).not.toThrow()
  })
})
