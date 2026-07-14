import { describe, expect, it } from "bun:test"

import { HTTPError } from "~/lib/error"
import {
  assertResponsesResultUsable,
  getResponsesResultFailureMessage,
} from "~/routes/messages/responses-result"
import { translateResponsesResultToAnthropic } from "~/routes/messages/responses-translation"

import type { ResponsesResult } from "~/services/copilot/create-responses"

const makeResult = (
  overrides: Partial<ResponsesResult> = {},
): ResponsesResult => ({
  id: "resp_status",
  object: "response",
  created_at: 0,
  model: "gpt-5.6-sol",
  output: [],
  output_text: "",
  status: "completed",
  usage: null,
  error: null,
  incomplete_details: null,
  instructions: null,
  metadata: null,
  parallel_tool_calls: false,
  temperature: null,
  tool_choice: null,
  tools: [],
  top_p: null,
  ...overrides,
})

describe("Responses semantic result validation", () => {
  it("accepts completed and incomplete results without errors", () => {
    expect(getResponsesResultFailureMessage(makeResult())).toBeUndefined()
    expect(
      getResponsesResultFailureMessage(makeResult({ status: "incomplete" })),
    ).toBeUndefined()
  })

  it("classifies cancelled and non-null error envelopes", () => {
    expect(
      getResponsesResultFailureMessage(makeResult({ status: "cancelled" })),
    ).toBe("Responses upstream ended with status=cancelled")
    expect(
      getResponsesResultFailureMessage(
        makeResult({
          error: { code: "server_error", message: "backend down" },
        }),
      ),
    ).toBe("backend down")
    expect(
      getResponsesResultFailureMessage(
        makeResult({ error: { code: "server_error", message: "   " } }),
      ),
    ).toBe("Responses upstream ended with status=completed")
  })

  it("returns a structured 502 and protects direct translators", async () => {
    const failed = makeResult({
      status: "failed",
      error: { code: "server_error", message: "backend down" },
    })

    expect(() => translateResponsesResultToAnthropic(failed)).toThrow(
      "Responses upstream failed: backend down",
    )

    let caught: unknown
    try {
      assertResponsesResultUsable(failed)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(HTTPError)
    const response = (caught as HTTPError).response
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({
      type: "error",
      error: { type: "api_error", message: "backend down" },
    })
  })
})
