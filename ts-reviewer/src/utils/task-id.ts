const jiraTaskPattern = /(?<![A-Z\d-])([A-Z][A-Z0-9]{1,9}-\d+)/i

export function findTaskId(text: string | undefined | null): string | null {
  if (!text) {
    return null
  }

  const match = text.match(jiraTaskPattern)
  return match?.[1]?.toUpperCase() ?? null
}

export function getTaskIdFromInputs(inputs: Array<string | undefined | null>): string | null {
  for (const input of inputs) {
    const taskId = findTaskId(input)
    if (taskId) {
      return taskId
    }
  }

  return null
}
