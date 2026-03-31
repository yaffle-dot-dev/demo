import { defineConfig } from "drizzle-kit"

function cleanDbUrl(raw: string): string {
  const url = new URL(raw)
  url.searchParams.delete("sslrootcert")
  return url.toString()
}

const dbUrl = cleanDbUrl(process.env.DATABASE_URL ?? "postgresql://yaffle@localhost:5432/yaffle_dev")

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  verbose: true,
  dbCredentials: {
    url: dbUrl,
  },
})
