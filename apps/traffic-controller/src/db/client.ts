import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"

import * as schema from "./schema.ts"

const DEFAULT_DATABASE_URL = "postgresql://yaffle@localhost:5432/yaffle_dev"

function cleanDbUrl(raw: string): string {
  const url = new URL(raw)
  url.searchParams.delete("sslrootcert")
  if (url.searchParams.get("sslmode") === "verify-full") {
    url.searchParams.set("sslmode", "require")
  }
  return url.toString()
}

let cachedDatabaseUrlPromise: Promise<string> | undefined
let cachedDbPromise: Promise<TrafficControlDb> | undefined

async function resolveDatabaseUrl(): Promise<string> {
  if (process.env.TRAFFIC_CONTROL_DATABASE_URL) {
    return cleanDbUrl(process.env.TRAFFIC_CONTROL_DATABASE_URL)
  }

  if (process.env.DATABASE_URL) {
    return cleanDbUrl(process.env.DATABASE_URL)
  }

  const secretId = process.env.TRAFFIC_CONTROL_DATABASE_URL_SECRET_ARN
  if (!secretId) {
    return DEFAULT_DATABASE_URL
  }

  const client = new SecretsManagerClient({})
  const secret = await client.send(new GetSecretValueCommand({ SecretId: secretId }))
  if (!secret.SecretString) {
    throw new Error(`Secrets Manager secret '${secretId}' did not contain SecretString`)
  }

  return cleanDbUrl(secret.SecretString)
}

export type TrafficControlDb = ReturnType<typeof drizzle<typeof schema>>

export async function getDatabaseUrl(): Promise<string> {
  cachedDatabaseUrlPromise ??= resolveDatabaseUrl()
  return cachedDatabaseUrlPromise
}

export async function getDb(): Promise<TrafficControlDb> {
  cachedDbPromise ??= (async () => {
    const databaseUrl = await getDatabaseUrl()
    const sql = postgres(databaseUrl, {
      max: 3,
      idle_timeout: 20,
      connect_timeout: 10,
    })

    return drizzle(sql, { schema })
  })()

  return cachedDbPromise
}
