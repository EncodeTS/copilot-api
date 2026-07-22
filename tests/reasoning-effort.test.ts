import { expect, test } from "bun:test"

import {
  normalizeGatewayReasoningEffort,
  normalizeGatewayReasoningEfforts,
  normalizeMessageReasoningEffort,
} from "~/lib/reasoning-effort"

test("normalizes runtime reasoning effort values into the shared domain", () => {
  expect(normalizeGatewayReasoningEffort("ultra")).toBe("ultra")
  expect(normalizeGatewayReasoningEffort("future-hyper")).toBeNull()
  expect(normalizeMessageReasoningEffort("none")).toBeNull()
  expect(normalizeMessageReasoningEffort("max")).toBe("max")

  expect(
    normalizeGatewayReasoningEfforts([
      "low",
      "future-hyper",
      "ultra",
      "low",
      42,
    ]),
  ).toEqual({
    efforts: ["low", "ultra"],
    rejected: ["future-hyper"],
    validArray: false,
  })
})
