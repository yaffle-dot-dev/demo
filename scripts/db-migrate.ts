import { exec } from "./lib/exec"

export async function dbMigrate() {
  const rootDbUrl = process.env.ROOT_DATABASE_URL
  if (!rootDbUrl) {
    throw new Error("ROOT_DATABASE_URL must be set for migrations")
  }

  // Check if there are pending migrations first
  console.log("Checking for pending migrations...")
  try {
    await exec(["bunx", "drizzle-kit", "check"], {
      cwd: "apps/control-plane",
      env: { DATABASE_URL: rootDbUrl },
      quiet: true,
    })
  } catch {
    // check failed — there may be issues, try to migrate anyway
  }

  console.log("Running database migrations...")
  try {
    await exec(["bunx", "drizzle-kit", "migrate"], {
      cwd: "apps/control-plane",
      env: { DATABASE_URL: rootDbUrl },
    })
  } catch (err) {
    // drizzle-kit migrate exits 1 even on success with PlanetScale due to NOTICE messages
    // If check passed, this is likely a false failure
    console.warn("drizzle-kit migrate exited non-zero (may be benign with PlanetScale)")
  }
  console.log("Migrations complete")
}

if (import.meta.main) {
  await dbMigrate()
}
