import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"

import * as schema from "../db/schema.ts"

const connectionString = process.env.DATABASE_URL ?? "postgresql://yaffle@localhost:5432/yaffle_dev"

const client = postgres(connectionString, {
  max: 10, // Maximum connections in the pool
  idle_timeout: 20, // Close idle connections after 20 seconds
  connect_timeout: 10, // Connection timeout in seconds
})

export const db = drizzle(client, { schema })
