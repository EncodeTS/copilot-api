import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test"
import { Hono } from "hono"

const actualConfigModule = await import("../src/lib/config")
const actualRateLimitModule = await import("../src/lib/rate-limit")
const actualResponsesModule =
  await import("../src/services/copilot/create-responses")

let responsesApiWebSocketEnabled = true

type CreateResponses = typeof actualResponsesModule.createResponses

const createResponses = mock<CreateResponses>(() =>
  Promise.resolve(streamChunks([])),
)

const createResponsesResult = (model: string) => ({
  created_at: 0,
  error: null,
  id: "resp-test",
  incomplete_details: null,
  instructions: null,
  metadata: null,
  model,
  object: "response" as const,
  output: [],
  output_text: "",
  parallel_tool_calls: false,
  status: "completed",
  temperature: null,
  tool_choice: "auto",
  tools: [],
  top_p: null,
  usage: null,
})

await mock.module("~/lib/config", () => ({
  ...actualConfigModule,
  getConfig: () => ({ useFunctionApplyPatch: true }),
  isResponsesApiWebSocketEnabled: () => responsesApiWebSocketEnabled,
  isResponsesApiWebSearchEnabled: () => true,
}))
await mock.module("~/lib/rate-limit", () => ({
  ...actualRateLimitModule,
  checkRateLimit: async () => {},
}))
await mock.module("~/services/copilot/create-responses", () => ({
  ...actualResponsesModule,
  createResponses,
}))

const { state } = await import("../src/lib/state")
const { responsesRoutes } = await import("../src/routes/responses/route")

const originalState = {
  copilotToken: state.copilotToken,
  lastRequestTimestamp: state.lastRequestTimestamp,
  manualApprove: state.manualApprove,
  models: state.models,
  rateLimitSeconds: state.rateLimitSeconds,
  rateLimitWait: state.rateLimitWait,
  verbose: state.verbose,
}

function createApp(): Hono {
  const app = new Hono()
  app.route("/v1/responses", responsesRoutes)
  return app
}

async function* streamChunks(items: Array<Record<string, unknown>>) {
  await Promise.resolve()
  for (const item of items) {
    yield item
  }
}

beforeEach(() => {
  state.copilotToken = "test-token"
  state.manualApprove = false
  state.verbose = false
  state.rateLimitSeconds = undefined
  state.rateLimitWait = false
  state.lastRequestTimestamp = undefined
  state.models = {
    object: "list",
    data: [
      {
        capabilities: {
          limits: {
            max_prompt_tokens: 128000,
          },
        },
        id: "gpt-test",
        supported_endpoints: ["/responses"],
      },
    ],
  } as typeof state.models

  responsesApiWebSocketEnabled = true
  createResponses.mockReset()
})

afterEach(() => {
  state.copilotToken = originalState.copilotToken
  state.manualApprove = originalState.manualApprove
  state.verbose = originalState.verbose
  state.rateLimitSeconds = originalState.rateLimitSeconds
  state.rateLimitWait = originalState.rateLimitWait
  state.lastRequestTimestamp = originalState.lastRequestTimestamp
  state.models = originalState.models
})

afterAll(() => {
  mock.restore()
})

describe("responses handler transport", () => {
  test("uses websocket transport by default for dual-endpoint models", async () => {
    state.models = {
      object: "list",
      data: [
        {
          capabilities: {
            limits: {
              max_prompt_tokens: 128000,
            },
          },
          id: "gpt-test",
          supported_endpoints: ["/responses", "ws:/responses"],
        },
      ],
    } as typeof state.models
    createResponses.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        input: "hello",
        model: "gpt-test",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponses).toHaveBeenCalledTimes(1)
    expect(createResponses.mock.calls[0][1].transport).toBe("websocket")
  })

  test("keeps HTTP transport for dual-endpoint models when websocket is disabled", async () => {
    state.models = {
      object: "list",
      data: [
        {
          capabilities: {
            limits: {
              max_prompt_tokens: 128000,
            },
          },
          id: "gpt-test",
          supported_endpoints: ["/responses", "ws:/responses"],
        },
      ],
    } as typeof state.models
    responsesApiWebSocketEnabled = false
    createResponses.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        input: "hello",
        model: "gpt-test",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponses).toHaveBeenCalledTimes(1)
    expect(createResponses.mock.calls[0][1].transport).toBe("http")
  })

  test("keeps HTTP transport when the selected model only supports /responses", async () => {
    createResponses.mockImplementation((payload) =>
      Promise.resolve(createResponsesResult(payload.model)),
    )

    const app = createApp()
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        input: "hello",
        model: "gpt-test",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(createResponses).toHaveBeenCalledTimes(1)
    expect(createResponses.mock.calls[0][1].transport).toBe("http")
  })
})
