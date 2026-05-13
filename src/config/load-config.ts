import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { logger } from "../core/logger.js"
import { opencodeConfigSchema, type OpencodeReviewerConfig } from "../core/models.js"

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const fallbackConfigPath = path.join(packageRoot, "opencode.json")
const fallbackReviewConfigPath = path.join(packageRoot, "review-config.json")

export async function loadConfig(repoPath: string): Promise<OpencodeReviewerConfig> {
  const parsed = await loadRawConfig(repoPath)
  return parseConfig(parsed)
}

export function parseConfig(rawConfig: Record<string, unknown>): OpencodeReviewerConfig {
  return opencodeConfigSchema.parse(rawConfig)
}

export async function loadRawConfig(repoPath: string): Promise<Record<string, unknown>> {
  const configPath = path.join(repoPath, "opencode.json")
  const reviewConfigPath = path.join(repoPath, "review-config.json")

  let opencodeConfig: Record<string, unknown> | undefined
  let configDir: string | undefined

  try {
    opencodeConfig = await readJsonFile(configPath)
    configDir = path.dirname(configPath)
  } catch (error) {
    logger.warn(`Could not load opencode.json at ${configPath}. Falling back to bundled config.`)
    logger.debug(error instanceof Error ? error.stack ?? error.message : String(error))

    try {
      opencodeConfig = await readJsonFile(fallbackConfigPath)
      configDir = path.dirname(fallbackConfigPath)
    } catch (fallbackError) {
      logger.warn(`Could not load fallback opencode.json at ${fallbackConfigPath}. Using defaults.`)
      logger.debug(fallbackError instanceof Error ? fallbackError.stack ?? fallbackError.message : String(fallbackError))
      opencodeConfig = {}
      configDir = packageRoot
    }
  }

  let reviewConfig: Record<string, unknown> | undefined

  try {
    reviewConfig = await readJsonFile(reviewConfigPath)
  } catch (error) {
    logger.debug(error instanceof Error ? error.stack ?? error.message : String(error))

    try {
      reviewConfig = await readJsonFile(fallbackReviewConfigPath)
    } catch (fallbackError) {
      logger.debug(fallbackError instanceof Error ? fallbackError.stack ?? fallbackError.message : String(fallbackError))
    }
  }

  return {
    ...opencodeConfig,
    review: extractReviewConfig(reviewConfig),
    __configDir: configDir,
  }
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown>> {
  const raw = await readFile(filePath, "utf8")
  return JSON.parse(raw) as Record<string, unknown>
}

function extractReviewConfig(rawConfig: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!rawConfig) {
    return undefined
  }

  const candidate = rawConfig.review
  if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
    return candidate as Record<string, unknown>
  }

  return rawConfig
}
