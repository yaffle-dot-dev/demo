import { buildImages } from "./build-images"
import { dbMigrate } from "./db-migrate"
import { deploy } from "./deploy"

console.log("=== Yaffle deploy-all ===\n")

await buildImages()
await dbMigrate()
await deploy()

console.log("\n=== deploy-all complete ===")
