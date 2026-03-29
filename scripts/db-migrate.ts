import { exec } from "./lib/exec"

export async function dbMigrate() {
  console.log("Running database migrations...")
  await exec(["bunx", "drizzle-kit", "migrate"], {
    cwd: "apps/control-plane",
  })
  console.log("Migrations complete")
}

if (import.meta.main) {
  await dbMigrate()
}
