import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { logger } from "../core/logger.js"
import { opencodeConfigSchema, type OpencodeReviewerConfig } from "../core/models.js"

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const fallbackConfigPath = path.join(packageRoot, "opencode.json")

export async function loadConfig(repoPath: string): Promise<OpencodeReviewerConfig> {
  const parsed = await loadRawConfig(repoPath)
  return opencodeConfigSchema.parse(parsed)
}

export async function loadRawConfig(repoPath: string): Promise<Record<string, unknown>> {
  const configPath = path.join(repoPath, "opencode.json")

  try {
    const raw = await readFile(configPath, "utf8")
    return {
      ...(JSON.parse(raw) as Record<string, unknown>),
      __configDir: path.dirname(configPath),
    }
  } catch (error) {
    logger.warn(`Could not load opencode.json at ${configPath}. Falling back to package config.`)
    logger.debug(error instanceof Error ? error.stack ?? error.message : String(error))

    try {
      const raw = await readFile(fallbackConfigPath, "utf8")
      return {
        ...(JSON.parse(raw) as Record<string, unknown>),
        __configDir: path.dirname(fallbackConfigPath),
      }
    } catch (fallbackError) {
      logger.warn(`Could not load fallback opencode.json at ${fallbackConfigPath}. Using defaults.`)
      logger.debug(fallbackError instanceof Error ? fallbackError.stack ?? fallbackError.message : String(fallbackError))
      return {}
    }
  }
}
