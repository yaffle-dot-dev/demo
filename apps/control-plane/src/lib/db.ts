import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"

import * as schema from "../db/schema.ts"

export const DEFAULT_DATABASE_URL = "postgresql://yaffle@localhost:5432/yaffle_dev"

export function cleanDbUrl(raw: string): string {
  try {
    const url = new URL(raw)
    url.searchParams.delete("sslrootcert")
    return url.toString()
  } catch {
    return raw
  }
}

export function getDatabaseUrl(): string {
  return cleanDbUrl(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL)
}

export function getDatabaseListenUrl(): string {
  return cleanDbUrl(process.env.DATABASE_LISTEN_URL ?? process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL)
}

const connectionString = getDatabaseUrl()

export const sql = postgres(connectionString, {
  max: 3, // Maximum connections in the pool
  idle_timeout: 20, // Close idle connections after 20 seconds
  connect_timeout: 10, // Connection timeout in seconds
})

export const db = drizzle(sql, { schema })
