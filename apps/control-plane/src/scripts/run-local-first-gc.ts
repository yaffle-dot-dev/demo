import { runLocalFirstGcOnce } from "../lib/local-first-gc.ts"

async function main(): Promise<void> {
  const result = await runLocalFirstGcOnce("manual")

  console.log(JSON.stringify(result, null, 2))
}

await main()
