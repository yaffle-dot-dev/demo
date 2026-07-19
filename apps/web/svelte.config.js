import adapter from "@sveltejs/adapter-node"
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte"

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter(),
    paths: {
      base: "/app",
    },
    version: {
      name: process.env.YAFFLE_BUILD_ID ?? "development",
    },
  },
}

export default config
