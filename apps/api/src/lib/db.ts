import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"

import * as schema from "../db/schema.ts"

const connectionString = process.env.DATABASE_URL ?? "postgresql://yaffle@localhost:5432/yaffle_dev"

const client = postgres(connectionString)

export const db = drizzle(client, { schema })
