import { expect, test } from "bun:test"

import { isLiveTestEnabled } from "./fixtures/live-tests"

test("live and network fixtures require an exact explicit opt-in", () => {
  expect(isLiveTestEnabled({})).toBeFalse()
  expect(isLiveTestEnabled({ COPILOT_API_RUN_LIVE_TESTS: "true" })).toBeFalse()
  expect(isLiveTestEnabled({ COPILOT_API_RUN_LIVE_TESTS: "0" })).toBeFalse()
  expect(isLiveTestEnabled({ COPILOT_API_RUN_LIVE_TESTS: "1" })).toBeTrue()
})
