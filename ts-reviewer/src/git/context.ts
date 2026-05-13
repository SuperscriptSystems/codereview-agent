import { getRecentCommitMessages } from "./diff.js"
import { getTaskIdFromInputs } from "../utils/task-id.js"

export async function getTaskIdFromGitInfo(repoPath: string, commitMessages: string): Promise<string | null> {
  const branchName = process.env.GITHUB_HEAD_REF ?? process.env.BITBUCKET_BRANCH ?? ""
  const envCommitMessage = process.env.BITBUCKET_COMMIT_MESSAGE ?? ""
  const recentCommitMessages = await getRecentCommitMessages(repoPath)

  return getTaskIdFromInputs([branchName, envCommitMessage, commitMessages, recentCommitMessages])
}
