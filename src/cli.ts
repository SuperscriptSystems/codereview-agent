import "dotenv/config"

import { Command } from "commander"

import { runAssessCommand } from "./commands/assess.js"
import { runCheckReviewerCommand } from "./commands/check-reviewer.js"
import { runReviewCommand } from "./commands/review.js"

const program = new Command()

program
  .name("code-review-agent")
  .description("OpenCode-based code review agent")

program
  .command("review")
  .description("Review staged or range-based changes")
  .option("--repo-path <path>", "Repository path", ".")
  .option("--base-ref <ref>", "Base git ref", "HEAD~1")
  .option("--head-ref <ref>", "Head git ref", "HEAD")
  .option("--staged", "Review staged changes", false)
  .option("--focus <area>", "Focus area", collectValues, [])
  .option("--trace", "Enable verbose logging", false)
  .action(async (options) => {
    await runReviewCommand(options)
  })

program
  .command("check-reviewer")
  .description("Verify OpenCode reviewer auth and connectivity")
  .option("--repo-path <path>", "Repository path", ".")
  .option("--trace", "Enable verbose logging", false)
  .action(async (options) => {
    await runCheckReviewerCommand(options)
  })

program
  .command("assess")
  .description("Summarize a change set for Jira assessment")
  .option("--repo-path <path>", "Repository path", ".")
  .option("--base-ref <ref>", "Base git ref", "HEAD~1")
  .option("--head-ref <ref>", "Head git ref", "HEAD")
  .option("--trace", "Enable verbose logging", false)
  .action(async (options) => {
    await runAssessCommand(options)
  })

void main()

async function main(): Promise<void> {
  try {
    if (process.argv.length <= 2) {
      await runReviewCommand({
        repoPath: ".",
        baseRef: "HEAD~1",
        headRef: "HEAD",
        staged: false,
        focus: [],
        trace: false,
      })
    } else {
      await program.parseAsync(process.argv)
    }
  } catch (error) {
    handleFatalError(error)
  }

  // This CLI runs one-shot commands in CI. Some underlying HTTP clients can keep
  // sockets alive after work completes, so exit explicitly once logs are flushed.
  await flushOutputStreams()
  process.exit(process.exitCode ?? 0)
}

function collectValues(value: string, previous: string[]): string[] {
  return [...previous, value]
}

function handleFatalError(error: unknown): void {
  const message = error instanceof Error ? error.stack ?? error.message : String(error)
  console.error(message)
  process.exitCode = 1
}

async function flushOutputStreams(): Promise<void> {
  await Promise.all([flushStream(process.stdout), flushStream(process.stderr)])
}

function flushStream(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    stream.write("", () => resolve())
  })
}
