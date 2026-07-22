import { defineConfig } from "vite-plus"

const IGNORE_PATTERNS = [
  "node_modules/**",
  "dist/**",
  ".astro/**",
  ".devenv/**",
  ".dev/**",
  ".direnv/**",
  ".agents/**",
  ".opencode/**",
  "actions/outputs-action/dist/**",
  "**/*.svelte",
]

export default defineConfig({
  fmt: {
    ignorePatterns: IGNORE_PATTERNS,
    printWidth: 100,
    tabWidth: 2,
    useTabs: false,
    semi: false,
    singleQuote: false,
    trailingComma: "all",
    sortPackageJson: false,
  },
  lint: {
    ignorePatterns: IGNORE_PATTERNS,
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  test: {
    environment: "node",
    exclude: [...IGNORE_PATTERNS, "**/*.smoke.test.ts"],
  },
  run: {
    cache: {
      scripts: true,
      tasks: true,
    },
  },
})
