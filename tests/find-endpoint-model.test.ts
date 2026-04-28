import { beforeEach, describe, expect, test } from "bun:test"

import type { Model } from "../src/services/copilot/get-models"

import { findEndpointModel } from "../src/lib/models"
import { state } from "../src/lib/state"

const m = (id: string): Model => ({ id }) as Model

const setModels = (ids: Array<string>) => {
  state.models = { data: ids.map((id) => m(id)), object: "list" }
}

describe("findEndpointModel", () => {
  beforeEach(() => {
    state.models = undefined
  })

  describe("with -1m suffix", () => {
    test("matches clean -1m variant by exact suffix", () => {
      setModels(["claude-opus-4.6", "claude-opus-4.6-1m"])

      const result = findEndpointModel("claude-opus-4-6", "-1m")

      expect(result?.id).toBe("claude-opus-4.6-1m")
    })

    test("matches -1m-internal variant when -1m clean variant absent", () => {
      // Reproduces the real Copilot model list for opus 4.7 where the only
      // 1M variant is suffixed with `-internal`.
      setModels([
        "claude-opus-4.6-1m",
        "claude-opus-4.6",
        "claude-opus-4.7-1m-internal",
        "claude-opus-4.7",
      ])

      const result = findEndpointModel("claude-opus-4-7", "-1m")

      expect(result?.id).toBe("claude-opus-4.7-1m-internal")
    })

    test("prefers shortest id when both -1m and -1m-internal exist", () => {
      setModels([
        "claude-opus-4.6-1m-internal",
        "claude-opus-4.6-1m",
        "claude-opus-4.6",
      ])

      const result = findEndpointModel("claude-opus-4-6", "-1m")

      expect(result?.id).toBe("claude-opus-4.6-1m")
    })

    test("falls back to base model when no 1m variant exists", () => {
      setModels(["claude-opus-4.6", "claude-opus-4.7"])

      const result = findEndpointModel("claude-opus-4-7", "-1m")

      expect(result?.id).toBe("claude-opus-4.7")
    })

    test("returns undefined when neither suffixed nor base model exists", () => {
      setModels(["claude-sonnet-4.6"])

      const result = findEndpointModel("claude-opus-4-7", "-1m")

      expect(result).toBeUndefined()
    })
  })

  describe("without suffix", () => {
    test("matches exact id when client uses Copilot's own dotted name", () => {
      setModels(["claude-opus-4.7", "claude-opus-4.7-1m-internal"])

      const result = findEndpointModel("claude-opus-4.7")

      expect(result?.id).toBe("claude-opus-4.7")
    })

    test("normalizes dashed id to dotted version", () => {
      setModels(["claude-opus-4.7", "claude-opus-4.7-1m-internal"])

      const result = findEndpointModel("claude-opus-4-7")

      expect(result?.id).toBe("claude-opus-4.7")
    })

    test("does not prefix-match (must be exact base)", () => {
      // No `claude-opus-4.7` in list; only the -1m-internal variant exists.
      // Without suffix we must NOT silently pick the longer 1M model.
      setModels(["claude-opus-4.7-1m-internal"])

      const result = findEndpointModel("claude-opus-4-7")

      expect(result).toBeUndefined()
    })

    test("strips date suffix when normalizing", () => {
      setModels(["claude-opus-4.5"])

      const result = findEndpointModel("claude-opus-4-5-20251101")

      expect(result?.id).toBe("claude-opus-4.5")
    })
  })
})
