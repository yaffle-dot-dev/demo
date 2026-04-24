import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

import type { YaffleTomlConfig } from "../../apps/control-plane/src/lib/config-toml"
import { parseYaffleToml } from "../../apps/control-plane/src/lib/config-toml"

const DEFAULT_CONFIG_PATH = resolve(import.meta.dir, "../..", "yaffle.toml")

export async function loadYaffleConfig(filePath = DEFAULT_CONFIG_PATH): Promise<YaffleTomlConfig> {
  const raw = await readFile(filePath, "utf8")
  return parseYaffleToml(raw)
}
