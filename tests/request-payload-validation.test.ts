import { describe, expect, test } from "bun:test"
import { Hono } from "hono"

import { HTTPError } from "../src/lib/error"
import {
  ANTHROPIC_MESSAGES_SHAPE,
  assertPayloadShape,
  CHAT_COMPLETIONS_SHAPE,
  createInvalidPayloadError,
  INVALID_REQUEST_BODY_CODE,
  readAnthropicMessagesPayload,
  readChatCompletionsPayload,
  readResponsesPayload,
  RESPONSES_SHAPE,
} from "../src/lib/request-payload-validation"

const readErrorBody = async (error: unknown) => {
  expect(error).toBeInstanceOf(HTTPError)
  const httpError = error as HTTPError
  expect(httpError.response.status).toBe(400)
  expect(httpError.response.headers.get("content-type")).toBe(
    "application/json",
  )
  return (await httpError.response.json()) as Record<string, never>
}

const expectRejection = async (run: () => unknown) => {
  try {
    await run()
  } catch (error) {
    return await readErrorBody(error)
  }
  throw new Error("expected the payload to be rejected")
}

describe("createInvalidPayloadError", () => {
  test("emits the native Anthropic error envelope", async () => {
    const body = await readErrorBody(
      createInvalidPayloadError("anthropic", "boom", "model"),
    )
    expect(body).toEqual({
      type: "error",
      error: { type: "invalid_request_error", message: "boom" },
    } as never)
  })

  test("emits the native OpenAI error envelope with param", async () => {
    const body = await readErrorBody(
      createInvalidPayloadError("openai", "boom", "model"),
    )
    expect(body).toEqual({
      error: {
        code: INVALID_REQUEST_BODY_CODE,
        message: "boom",
        param: "model",
        type: "invalid_request_error",
      },
    } as never)
  })

  test("omits param when the field is unknown", async () => {
    const body = await readErrorBody(
      createInvalidPayloadError("openai", "boom"),
    )
    expect(Object.hasOwn(body.error as object, "param")).toBe(false)
  })
})

describe("assertPayloadShape root and model checks", () => {
  const rejectingRoots: Array<[string, unknown, string]> = [
    ["null", null, "null"],
    ["array", [], "an array"],
    ["string", "hello", "a string"],
    ["number", 5, "an integer"],
    ["float", 1.5, "a number"],
    ["boolean", true, "a boolean"],
  ]

  for (const [label, value, described] of rejectingRoots) {
    test(`rejects a ${label} request body`, async () => {
      const body = await expectRejection(() =>
        assertPayloadShape("openai", value, RESPONSES_SHAPE),
      )
      expect((body.error as { message: string }).message).toBe(
        `Invalid type for the request body: expected an object, but got ${described} instead.`,
      )
    })
  }

  test("rejects a missing model", async () => {
    const body = await expectRejection(() =>
      assertPayloadShape("openai", { input: "hi" }, RESPONSES_SHAPE),
    )
    expect(body.error).toMatchObject({
      message: "Missing required parameter: 'model'.",
      param: "model",
    } as never)
  })

  test("rejects a null model", async () => {
    const body = await expectRejection(() =>
      assertPayloadShape("openai", { model: null }, RESPONSES_SHAPE),
    )
    expect((body.error as { message: string }).message).toBe(
      "Missing required parameter: 'model'.",
    )
  })

  test("rejects a non-string model", async () => {
    const body = await expectRejection(() =>
      assertPayloadShape("openai", { model: { a: 1 } }, RESPONSES_SHAPE),
    )
    expect((body.error as { message: string }).message).toBe(
      "Invalid type for 'model': expected a string, but got an object instead.",
    )
  })

  test("rejects a blank model", async () => {
    const body = await expectRejection(() =>
      assertPayloadShape("openai", { model: "  " }, RESPONSES_SHAPE),
    )
    expect((body.error as { message: string }).message).toBe(
      "Invalid value for 'model': expected a non-empty string.",
    )
  })

  test("returns the payload unchanged when the shape is valid", () => {
    const payload = { model: "gpt-5.5", input: "hi" }
    expect(assertPayloadShape("openai", payload, RESPONSES_SHAPE)).toBe(payload)
  })
})

describe("assertPayloadShape container checks", () => {
  const anthropic = (extra: Record<string, unknown>) => ({
    model: "claude-sonnet-5",
    max_tokens: 16,
    messages: [{ role: "user", content: "hi" }],
    ...extra,
  })

  test("requires messages to be present", async () => {
    const body = await expectRejection(() =>
      assertPayloadShape(
        "anthropic",
        { model: "claude-sonnet-5" },
        ANTHROPIC_MESSAGES_SHAPE,
      ),
    )
    expect((body.error as { message: string }).message).toBe(
      "Missing required parameter: 'messages'.",
    )
  })

  test("rejects a non-array messages field", async () => {
    const body = await expectRejection(() =>
      assertPayloadShape(
        "anthropic",
        anthropic({ messages: {} }),
        ANTHROPIC_MESSAGES_SHAPE,
      ),
    )
    expect((body.error as { message: string }).message).toBe(
      "Invalid type for 'messages': expected an array, but got an object instead.",
    )
  })

  test("rejects null members inside messages", async () => {
    const body = await expectRejection(() =>
      assertPayloadShape(
        "anthropic",
        anthropic({ messages: [null] }),
        ANTHROPIC_MESSAGES_SHAPE,
      ),
    )
    expect((body.error as { message: string }).message).toBe(
      "Invalid type for 'messages[0]': expected an object, but got null instead.",
    )
  })

  test("rejects a non-array tools field", async () => {
    const body = await expectRejection(() =>
      assertPayloadShape(
        "anthropic",
        anthropic({ tools: {} }),
        ANTHROPIC_MESSAGES_SHAPE,
      ),
    )
    expect((body.error as { message: string }).message).toBe(
      "Invalid type for 'tools': expected an array, but got an object instead.",
    )
  })

  test("rejects null members inside tools", async () => {
    const body = await expectRejection(() =>
      assertPayloadShape(
        "anthropic",
        anthropic({ tools: [null] }),
        ANTHROPIC_MESSAGES_SHAPE,
      ),
    )
    expect((body.error as { message: string }).message).toBe(
      "Invalid type for 'tools[0]': expected an object, but got null instead.",
    )
  })

  test("rejects a numeric system field", async () => {
    const body = await expectRejection(() =>
      assertPayloadShape(
        "anthropic",
        anthropic({ system: 5 }),
        ANTHROPIC_MESSAGES_SHAPE,
      ),
    )
    expect((body.error as { message: string }).message).toBe(
      "Invalid type for 'system': expected one of a string or an array, but got an integer instead.",
    )
  })

  test("accepts a string system field", () => {
    expect(() =>
      assertPayloadShape(
        "anthropic",
        anthropic({ system: "be brief" }),
        ANTHROPIC_MESSAGES_SHAPE,
      ),
    ).not.toThrow()
  })

  test("rejects null members inside an array system field", async () => {
    const body = await expectRejection(() =>
      assertPayloadShape(
        "anthropic",
        anthropic({ system: [null] }),
        ANTHROPIC_MESSAGES_SHAPE,
      ),
    )
    expect((body.error as { message: string }).message).toBe(
      "Invalid type for 'system[0]': expected an object, but got null instead.",
    )
  })

  test("rejects a non-object thinking field", async () => {
    const body = await expectRejection(() =>
      assertPayloadShape(
        "anthropic",
        anthropic({ thinking: "yes" }),
        ANTHROPIC_MESSAGES_SHAPE,
      ),
    )
    expect((body.error as { message: string }).message).toBe(
      "Invalid type for 'thinking': expected an object, but got a string instead.",
    )
  })

  test("allows a null optional object field through to upstream", () => {
    expect(() =>
      assertPayloadShape(
        "anthropic",
        anthropic({ thinking: null, tools: null }),
        ANTHROPIC_MESSAGES_SHAPE,
      ),
    ).not.toThrow()
  })

  test("rejects a non-array, non-string message content", async () => {
    const body = await expectRejection(() =>
      assertPayloadShape(
        "anthropic",
        anthropic({ messages: [{ role: "user", content: 5 }] }),
        ANTHROPIC_MESSAGES_SHAPE,
      ),
    )
    expect((body.error as { message: string }).message).toBe(
      "Invalid type for 'messages[0].content': expected one of a string or an array, but got an integer instead.",
    )
  })

  test("rejects null members inside message content", async () => {
    const body = await expectRejection(() =>
      assertPayloadShape(
        "anthropic",
        anthropic({ messages: [{ role: "user", content: [null] }] }),
        ANTHROPIC_MESSAGES_SHAPE,
      ),
    )
    expect((body.error as { message: string }).message).toBe(
      "Invalid type for 'messages[0].content[0]': expected an object, but got null instead.",
    )
  })

  test("skips content checks for non-object message members", () => {
    // `messages` members are validated first, so a valid-object member with an
    // absent content field must not trip the content walk.
    expect(() =>
      assertPayloadShape(
        "anthropic",
        anthropic({ messages: [{ role: "user" }] }),
        ANTHROPIC_MESSAGES_SHAPE,
      ),
    ).not.toThrow()
  })

  test("ignores message content walks for absent fields", () => {
    expect(() =>
      assertPayloadShape("openai", { model: "gpt-5.5" }, RESPONSES_SHAPE),
    ).not.toThrow()
  })

  test("rejects null members inside responses input", async () => {
    const body = await expectRejection(() =>
      assertPayloadShape(
        "openai",
        { model: "gpt-5.5", input: [null] },
        RESPONSES_SHAPE,
      ),
    )
    expect((body.error as { message: string }).message).toBe(
      "Invalid type for 'input[0]': expected an object, but got null instead.",
    )
  })

  test("rejects a non-array responses tools field", async () => {
    const body = await expectRejection(() =>
      assertPayloadShape(
        "openai",
        { model: "gpt-5.5", input: "hi", tools: {} },
        RESPONSES_SHAPE,
      ),
    )
    expect((body.error as { message: string }).message).toBe(
      "Invalid type for 'tools': expected an array, but got an object instead.",
    )
  })

  test("rejects a non-array chat completions messages field", async () => {
    const body = await expectRejection(() =>
      assertPayloadShape(
        "openai",
        { model: "gpt-5.5", messages: {} },
        CHAT_COMPLETIONS_SHAPE,
      ),
    )
    expect((body.error as { message: string }).message).toBe(
      "Invalid type for 'messages': expected an array, but got an object instead.",
    )
  })

  test("reports a missing required field that is absent", async () => {
    const body = await expectRejection(() =>
      assertPayloadShape(
        "openai",
        { model: "gpt-5.5" },
        {
          fields: [
            { field: "input", required: true, container: "stringOrArray" },
          ],
          contentFields: [],
        },
      ),
    )
    expect(body.error).toMatchObject({
      message: "Missing required parameter: 'input'.",
      param: "input",
    } as never)
  })

  test("skips container enforcement when no container is declared", () => {
    // `input` on the Responses shape carries member checks only, so a wrongly
    // typed container must reach upstream for its authoritative message.
    expect(() =>
      assertPayloadShape(
        "openai",
        { model: "gpt-5.5", input: 5 },
        RESPONSES_SHAPE,
      ),
    ).not.toThrow()
  })

  test("leaves fields outside the crash surface untouched", () => {
    // Upstream accepts these, so the gateway must not become stricter.
    expect(() =>
      assertPayloadShape(
        "openai",
        { model: "gpt-5.5", input: "hi", metadata: "x", include: "x" },
        RESPONSES_SHAPE,
      ),
    ).not.toThrow()
    expect(() =>
      assertPayloadShape(
        "anthropic",
        anthropic({ metadata: "x" }),
        ANTHROPIC_MESSAGES_SHAPE,
      ),
    ).not.toThrow()
  })

  test("accepts a string-or-array field given an array of objects", () => {
    expect(() =>
      assertPayloadShape(
        "anthropic",
        anthropic({ system: [{ type: "text", text: "hi" }] }),
        ANTHROPIC_MESSAGES_SHAPE,
      ),
    ).not.toThrow()
  })
})

describe("readValidatedPayload over a live request", () => {
  const buildApp = () => {
    const app = new Hono()
    const wrap =
      (read: (c: never) => Promise<unknown>) =>
      async (c: never): Promise<Response> => {
        try {
          return Response.json({ ok: await read(c) })
        } catch (error) {
          if (error instanceof HTTPError) return error.response
          throw error
        }
      }
    app.post("/messages", wrap(readAnthropicMessagesPayload) as never)
    app.post("/responses", wrap(readResponsesPayload) as never)
    app.post("/chat", wrap(readChatCompletionsPayload) as never)
    return app
  }

  const post = async (path: string, raw: string) =>
    await buildApp().request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw,
    })

  test("rejects malformed JSON with the Anthropic envelope", async () => {
    const res = await post("/messages", "{not json")
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "The request body is not valid JSON.",
      },
    } as never)
  })

  test("rejects an empty body with the OpenAI envelope", async () => {
    const res = await post("/responses", "")
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({
      error: {
        code: INVALID_REQUEST_BODY_CODE,
        message: "The request body is not valid JSON.",
      },
    } as never)
  })

  test("rejects a missing model on chat completions", async () => {
    const res = await post("/chat", JSON.stringify({ messages: [] }))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({
      error: {
        message: "Missing required parameter: 'model'.",
        param: "model",
      },
    } as never)
  })

  test("passes a well-formed payload through untouched", async () => {
    const payload = {
      model: "claude-sonnet-5",
      max_tokens: 16,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    }
    const res = await post("/messages", JSON.stringify(payload))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: payload } as never)
  })
})
