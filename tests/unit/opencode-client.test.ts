import { describe, expect, it } from "vitest"

import { __test__ } from "../../src/opencode/client.js"

describe("opencode client structured output extraction", () => {
  it("reads structured output from v2 info.structured", () => {
    expect(__test__.getStructuredOutputInfo({
      info: {
        structured: { issues: [] },
      },
    })).toEqual({
      structured_output: { issues: [] },
      error: undefined,
    })
  })

  it("reads structured output from wrapped data.info.structured", () => {
    expect(__test__.getStructuredOutputInfo({
      data: {
        info: {
          structured: { issues: [] },
        },
      },
    })).toEqual({
      structured_output: { issues: [] },
      error: undefined,
    })
  })

  it("normalizes StructuredOutputError message from nested data.message", () => {
    expect(__test__.getStructuredOutputInfo({
      info: {
        error: {
          name: "StructuredOutputError",
          data: { message: "schema validation failed" },
        },
      },
    })).toEqual({
      structured_output: undefined,
      error: {
        name: "StructuredOutputError",
        message: "schema validation failed",
      },
    })
  })
})
