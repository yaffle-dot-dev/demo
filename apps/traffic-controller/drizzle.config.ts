import { defineConfig } from "drizzle-kit"

function cleanDbUrl(raw: string): string {
  const url = new URL(raw)
  url.searchParams.delete("sslrootcert")
  if (url.searchParams.get("sslmode") === "verify-full") {
    url.searchParams.set("sslmode", "require")
  }
  return url.toString()
}

const dbUrl = cleanDbUrl(
  process.env.TRAFFIC_CONTROL_DATABASE_URL ??
    process.env.TRAFFIC_CONTROL_ADMIN_DATABASE_URL ??
    process.env.DATABASE_URL ??
    "postgresql://yaffle@localhost:5432/yaffle_dev",
)

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  verbose: true,
  migrations: {
    schema: "traffic_control",
    table: "__drizzle_migrations",
  },
  dbCredentials: {
    url: dbUrl,
  },
})
