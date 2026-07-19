import { defineConfig } from "vite-plus"

export default defineConfig({
  pack: {
    deps: {
      alwaysBundle: [/.*/],
      neverBundle: ["minijinja-js"],
    },
  },
  test: {
    setupFiles: ["./src/test-utils/setup.ts"],
  },
})
