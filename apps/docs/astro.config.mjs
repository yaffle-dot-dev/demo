// @ts-check
import { defineConfig } from "astro/config"
import starlight from "@astrojs/starlight"

// https://astro.build/config
export default defineConfig({
  site: "https://yaffle.dev",
  base: "/docs",
  vite: {
    server: {
      allowedHosts: ["yaffle.local", "localhost"],
    },
  },
  integrations: [
    starlight({
      title: "Yaffle",
      tagline: "Run OpenTofu from PR to production",
      description:
        "The OpenTofu platform with remote execution, state management, and preview environments.",
      logo: {
        src: "./src/assets/yaffle-bird.png",
        alt: "Yaffle",
        replacesTitle: false,
      },
      favicon: "/favicon.png",
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/yaffledev/yaffle",
        },
      ],
      editLink: {
        baseUrl: "https://github.com/yaffledev/yaffle/edit/main/apps/docs/",
      },
      customCss: ["./src/styles/custom.css"],
      sidebar: [
        {
          label: "Start",
          items: [
            { label: "Introduction", slug: "getting-started/introduction" },
            { label: "Quick Start", slug: "getting-started/quickstart" },
          ],
        },
        {
          label: "Concepts",
          items: [
            { label: "How it works", slug: "concepts/how-it-works" },
            { label: "Workspaces", slug: "concepts/workspaces" },
            { label: "Previews", slug: "concepts/previews" },
            { label: "Runs", slug: "concepts/runs" },
            { label: "State", slug: "concepts/state" },
          ],
        },
        {
          label: "Guides",
          items: [
            { label: "GitHub", slug: "guides/github" },
            { label: "CI/CD Integration", slug: "guides/ci-cd" },
            { label: "AWS", slug: "guides/aws" },
            { label: "Migrating from Atlantis", slug: "guides/atlantis" },
            { label: "Yaffle vs Alternatives", slug: "guides/alternatives" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "Configuration", slug: "reference/configuration" },
          ],
        },
      ],
    }),
  ],
})
