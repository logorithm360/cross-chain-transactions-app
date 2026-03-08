import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { config as dotenvConfig } from "dotenv"

let loaded = false

export function loadCliEnv(): void {
  if (loaded) return

  const candidates = [
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "..", ".env"),
  ]

  for (const path of candidates) {
    if (existsSync(path)) {
      dotenvConfig({ path, override: false })
    }
  }

  loaded = true
}
