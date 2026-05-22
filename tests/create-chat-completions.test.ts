import { afterEach, beforeEach, expect, test } from "bun:test"

import type { ChatCompletionsPayload } from "../src/services/copilot/create-chat-completions"

import { state } from "../src/lib/state"
import { prepareChatCompletionsHeaders } from "../src/services/copilot/create-chat-completions"

const originalState = {
  accountType: state.accountType,
  copilotToken: state.copilotToken,
  vsCodeVersion: state.vsCodeVersion,
}

beforeEach(() => {
  state.copilotToken = "test-token"
  state.vsCodeVersion = "1.0.0"
  state.accountType = "individual"
})

afterEach(() => {
  state.copilotToken = originalState.copilotToken
  state.vsCodeVersion = originalState.vsCodeVersion
  state.accountType = originalState.accountType
})

test("sets x-initiator to agent if tool/assistant present", () => {
  const payload: ChatCompletionsPayload = {
    messages: [
      { role: "user", content: "hi" },
      { role: "tool", content: "tool call" },
    ],
    model: "gpt-test",
  }
  const headers = prepareChatCompletionsHeaders(payload, { requestId: "1" })
  expect(headers["x-initiator"]).toBe("agent")
})

test("sets x-initiator to user if only user present", () => {
  const payload: ChatCompletionsPayload = {
    messages: [
      { role: "user", content: "hi" },
      { role: "user", content: "hello again" },
    ],
    model: "gpt-test",
  }
  const headers = prepareChatCompletionsHeaders(payload, { requestId: "1" })
  expect(headers["x-initiator"]).toBe("user")
})
