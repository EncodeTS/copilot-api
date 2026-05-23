import { afterEach, describe, expect, test } from "bun:test"

import { state } from "~/lib/state"
import { getModels } from "~/services/codex/get-models"
import {
  buildCodexResponsesWebSocketPayload,
  buildCodexResponsesWebSocketUrl,
  buildCodexResponsesHeaders,
  createStandardizedCodexResponsesEventStream,
  normalizeCodexResponsesEvent,
  prepareCodexResponsesWebSocketRequest,
  resolveCodexResponsesUrl,
} from "~/services/codex/create-responses"

const originalCodexAccessToken = state.codexAccessToken
const originalCodexAccountId = state.codexAccountId

afterEach(() => {
  state.codexAccessToken = originalCodexAccessToken
  state.codexAccountId = originalCodexAccountId
})

async function* streamChunks(
  items: Array<{
    data?: string
    event?: string
    id?: string
  }>,
) {
  await Promise.resolve()
  for (const item of items) {
    yield item
  }
}

describe("codex api helpers", () => {
  test("resolves the ChatGPT Codex responses path", () => {
    expect(resolveCodexResponsesUrl()).toBe(
      "https://chatgpt.com/backend-api/codex/responses",
    )
    expect(resolveCodexResponsesUrl("https://chatgpt.com/backend-api/")).toBe(
      "https://chatgpt.com/backend-api/codex/responses",
    )
    expect(
      resolveCodexResponsesUrl("https://chatgpt.com/backend-api/codex"),
    ).toBe("https://chatgpt.com/backend-api/codex/responses")
    expect(
      resolveCodexResponsesUrl(
        "https://chatgpt.com/backend-api/codex/responses",
      ),
    ).toBe("https://chatgpt.com/backend-api/codex/responses")
  })

  test("normalizes codex response.done events", () => {
    const normalized = normalizeCodexResponsesEvent({
      type: "response.done",
      response: {
        created_at: 0,
        error: null,
        id: "resp_123",
        incomplete_details: null,
        instructions: null,
        metadata: null,
        model: "gpt-5.4",
        object: "response",
        output: [],
        output_text: "",
        parallel_tool_calls: true,
        status: "completed",
        temperature: null,
        tool_choice: "auto",
        tools: [],
        top_p: null,
        usage: null,
      },
    })

    expect(normalized).toMatchObject({
      type: "response.completed",
      response: {
        status: "completed",
      },
    })
  })

  test("standardizes codex SSE events to response.completed", async () => {
    const stream = createStandardizedCodexResponsesEventStream(
      streamChunks([
        {
          data: JSON.stringify({
            response: {
              created_at: 0,
              error: null,
              id: "resp_123",
              incomplete_details: null,
              instructions: null,
              metadata: null,
              model: "gpt-5.4",
              object: "response",
              output: [],
              output_text: "hello",
              parallel_tool_calls: true,
              status: "completed",
              temperature: null,
              tool_choice: "auto",
              tools: [],
              top_p: null,
              usage: null,
            },
            sequence_number: 1,
            type: "response.done",
          }),
          event: "response.done",
          id: "event_1",
        },
        {
          data: "[DONE]",
        },
      ]),
    )

    const body = await new Response(stream).text()

    expect(body).toContain("id: event_1")
    expect(body).toContain("event: response.completed")
    expect(body).toContain('"type":"response.completed"')
    expect(body).not.toContain('"type":"response.done"')
    expect(body).toContain("data: [DONE]")
  })

  test("builds the ChatGPT Codex websocket responses path", () => {
    expect(buildCodexResponsesWebSocketUrl()).toBe(
      "wss://chatgpt.com/backend-api/codex/responses",
    )
    expect(
      buildCodexResponsesWebSocketUrl("https://chatgpt.com/backend-api/"),
    ).toBe("wss://chatgpt.com/backend-api/codex/responses")
  })

  test("builds the Codex websocket response.create payload", () => {
    const payload = buildCodexResponsesWebSocketPayload({
      input: "hello",
      model: "gpt-5.4",
      store: false,
      stream: true,
    })

    expect(payload).toEqual({
      input: "hello",
      model: "gpt-5.4",
      store: false,
      type: "response.create",
    })
    expect("stream" in payload).toBe(false)
  })

  test("overrides request account headers with loaded codex auth context", () => {
    state.codexAccessToken = "codex-token"
    state.codexAccountId = "codex-account"

    const headers = buildCodexResponsesHeaders(
      new Headers({
        accept: "text/plain",
        authorization: "Bearer request-token",
        "chatgpt-account-id": "request-account",
        connection: "keep-alive",
        "content-type": "application/cloudevents+json",
        "openai-beta": "responses=stable",
        originator: "test-client",
        "user-agent": "test-agent",
        "x-trace-id": "trace-123",
      }),
    )

    expect(headers.get("authorization")).toBe("Bearer codex-token")
    expect(headers.get("chatgpt-account-id")).toBe("codex-account")
    expect(headers.get("connection")).toBeNull()
    expect(headers.get("content-type")).toBe("application/cloudevents+json")
    expect(headers.get("openai-beta")).toBe("responses=stable")
    expect(headers.get("originator")).toBe("test-client")
    expect(headers.get("user-agent")).toBe("test-agent")
    expect(headers.get("x-trace-id")).toBe("trace-123")
  })

  test("fills missing codex headers when the request omits them", () => {
    state.codexAccessToken = "codex-token"
    state.codexAccountId = "codex-account"

    const headers = buildCodexResponsesHeaders(new Headers())

    expect(headers.get("authorization")).toBe("Bearer codex-token")
    expect(headers.get("chatgpt-account-id")).toBe("codex-account")
    expect(headers.get("content-type")).toBe("application/json")
    expect(headers.get("openai-beta")).toBe("responses=experimental")
    expect(headers.get("originator")).toBe("copilot-api")
    expect(headers.get("user-agent")).toBe("copilot-api")
  })

  test("prepares websocket requests without HTTP-only headers", () => {
    state.codexAccessToken = "codex-token"
    state.codexAccountId = "codex-account"

    const request = prepareCodexResponsesWebSocketRequest(
      {
        input: "hello",
        model: "gpt-5.4",
        stream: true,
      },
      new Headers({
        accept: "text/plain",
        "content-type": "application/json",
        "x-trace-id": "trace-123",
      }),
    )

    expect(request.url).toBe("wss://chatgpt.com/backend-api/codex/responses")
    expect(request.payload).toMatchObject({
      input: "hello",
      model: "gpt-5.4",
      type: "response.create",
    })
    expect(request.headers.accept).toBeUndefined()
    expect(request.headers["content-type"]).toBeUndefined()
    expect(request.headers["x-trace-id"]).toBe("trace-123")
    expect(request.headers.authorization).toBe("Bearer codex-token")
  })

  test("returns the static codex model catalog", () => {
    const models = getModels()

    expect(models.object).toBe("list")
    expect(models.data.map((model) => model.id)).toEqual([
      "gpt-5.3-codex-spark",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.5",
    ])
    expect(
      models.data.every(
        (model) => !model.supported_endpoints?.includes("/v1/embeddings"),
      ),
    ).toBe(true)
  })
})
