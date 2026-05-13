import { describe, expect, it } from "vitest"

import { findTaskId, getTaskIdFromInputs } from "../../src/utils/task-id.js"

describe("task id extraction", () => {
  it("extracts jira-like keys", () => {
    expect(findTaskId("feature/PROJ-123-add-reviewer")).toBe("PROJ-123")
  })

  it("returns null when no task id exists", () => {
    expect(findTaskId("feature/no-task-id")).toBeNull()
  })

  it("scans multiple inputs in order", () => {
    expect(getTaskIdFromInputs(["", "feat: ABC-456 improve flow", "ZZZ-1"])) .toBe("ABC-456")
  })
})
