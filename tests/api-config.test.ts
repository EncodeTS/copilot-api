import { afterEach, expect, test } from "bun:test"

import { prepareMessageProxyHeaders } from "../src/lib/api-config"

const originalOauthApp = process.env.COPILOT_API_OAUTH_APP

afterEach(() => {
  if (originalOauthApp === undefined) {
    delete process.env.COPILOT_API_OAUTH_APP
    return
  }

  process.env.COPILOT_API_OAUTH_APP = originalOauthApp
})

test("prepareMessageProxyHeaders applies message proxy headers by default", () => {
  delete process.env.COPILOT_API_OAUTH_APP

  const headers: Record<string, string> = {
    "user-agent": "GitHubCopilotChat/0.42.3",
  }

  prepareMessageProxyHeaders(headers)

  expect(headers["x-interaction-type"]).toBe("messages-proxy")
  expect(headers["openai-intent"]).toBe("messages-proxy")
  expect(headers["user-agent"]).toBe(
    "vscode_claude_code/2.1.81 (external, sdk-ts, agent-sdk/0.2.81)",
  )
  expect(headers["x-request-id"]).toBeDefined()
  expect(headers["x-agent-task-id"]).toBe(headers["x-request-id"])
})

test("prepareMessageProxyHeaders leaves opencode headers untouched", () => {
  process.env.COPILOT_API_OAUTH_APP = "opencode"

  const headers: Record<string, string> = {
    "Openai-Intent": "conversation-edits",
    "User-Agent": "opencode/1.0.0",
  }

  prepareMessageProxyHeaders(headers)

  expect(headers).toEqual({
    "Openai-Intent": "conversation-edits",
    "User-Agent": "opencode/1.0.0",
  })
})
