import { describe, expect, it } from "vitest"

import { filterFilesByPattern, filterTestFiles, shouldIgnorePath } from "../../src/git/filtering.js"

describe("filtering", () => {
  it("filters test files by path segment", () => {
    const result = filterTestFiles(
      {
        "src/services/UserService.cs": "...",
        "src/tests/UserService.Tests.cs": "...",
        "src/spec/component.spec.js": "...",
      },
      ["test", "tests", "spec"],
    )

    expect(result).toEqual({
      "src/services/UserService.cs": "...",
    })
  })

  it("filters common dotted test filenames", () => {
    const result = filterTestFiles(
      {
        "src/app.ts": "...",
        "src/app.test.ts": "...",
        "src/component.spec.tsx": "...",
      },
      ["test", "spec"],
    )

    expect(result).toEqual({
      "src/app.ts": "...",
    })
  })

  it("filters ignored filename patterns", () => {
    const result = filterFilesByPattern(
      {
        "src/index.ts": "...",
        "package-lock.json": "...",
      },
      ["package-lock.json"],
    )

    expect(result).toEqual({
      "src/index.ts": "...",
    })
  })

  it("matches ignored paths and extensions", () => {
    expect(
      shouldIgnorePath("node_modules/pkg/index.js", {
        ignoredExtensions: [".png"],
        ignoredPaths: ["node_modules"],
        ignoredPatterns: [],
      }),
    ).toBe(true)

    expect(
      shouldIgnorePath("assets/logo.png", {
        ignoredExtensions: [".png"],
        ignoredPaths: [],
        ignoredPatterns: [],
      }),
    ).toBe(true)
  })
})
