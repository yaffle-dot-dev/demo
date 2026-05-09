import { dirname } from "node:path"
import { fileURLToPath } from "node:url"

export function importMetaDir(meta: ImportMeta): string {
  return dirname(fileURLToPath(meta.url))
}

export function isMain(meta: ImportMeta): boolean {
  return process.argv[1] != null && fileURLToPath(meta.url) === process.argv[1]
}
