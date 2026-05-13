export function createAnnotatedFile(fullContent: string, _diffContent: string): string {
  const lines = fullContent.split(/\r?\n/)
  return lines.map((line, index) => `     ${String(index + 1).padStart(4, " ")}   ${line}`).join("\n")
}
