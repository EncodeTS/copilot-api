import { afterEach, expect, mock, test } from "bun:test"

import {
  debugJson,
  debugJsonAsync,
  debugJsonTail,
  debugLazy,
  redactLogString,
} from "../src/lib/logger"
import { state } from "../src/lib/state"

afterEach(() => {
  state.verbose = false
})

test("debugJson skips serialization when verbose logging is disabled", () => {
  state.verbose = false

  const logger = {
    debug: mock(() => {}),
  }
  const toJSON = mock(() => ({ ok: true }))

  debugJson(logger as never, "payload", { toJSON })

  expect(toJSON).not.toHaveBeenCalled()
  expect(logger.debug).not.toHaveBeenCalled()
})

test("debugJson logs the serialized payload when verbose logging is enabled", () => {
  state.verbose = true

  const logger = {
    debug: mock(() => {}),
  }
  const payload = { ok: true }

  debugJson(logger as never, "payload", payload)

  expect(logger.debug).toHaveBeenCalledWith("payload", JSON.stringify(payload))
})

test("debugJsonAsync skips reading when verbose logging is disabled", async () => {
  state.verbose = false

  const logger = {
    debug: mock(() => {}),
  }
  const readValue = mock(() => Promise.resolve({ body: "request body" }))

  await debugJsonAsync(logger as never, "payload", readValue)

  expect(readValue).not.toHaveBeenCalled()
  expect(logger.debug).not.toHaveBeenCalled()
})

test("debugJsonAsync reads and logs when verbose logging is enabled", async () => {
  state.verbose = true

  const logger = {
    debug: mock(() => {}),
  }
  const payload = { body: "response body" }
  const readValue = mock(() => Promise.resolve(payload))

  await debugJsonAsync(logger as never, "payload", readValue)

  expect(readValue).toHaveBeenCalledTimes(1)
  expect(logger.debug).toHaveBeenCalledWith("payload", JSON.stringify(payload))
})

test("debugJsonAsync redacts media payloads when verbose logging is enabled", async () => {
  state.verbose = true

  const logger = {
    debug: mock(() => {}),
  }
  const imageDataUrl = `data:image/png;base64,${"E".repeat(64)}`

  await debugJsonAsync(logger as never, "payload", async () => ({
    image_url: imageDataUrl,
  }))

  const serialized = (
    logger.debug.mock.calls as Array<Array<unknown>>
  )[0][1] as string
  expect(serialized).toContain("[redacted_media")
  expect(serialized).not.toContain(imageDataUrl)
  expect(serialized).not.toContain(";base64,")
})

test("debugJson redacts media payloads when verbose logging is enabled", () => {
  state.verbose = true

  const logger = {
    debug: mock(() => {}),
  }
  const imageDataUrl = `data:image/png;base64,${"A".repeat(64)}`
  const fileDataUrl = `data:application/pdf;base64,${"B".repeat(64)}`
  const signedUrl =
    "https://private.example.test/media/screenshot.png?sig=secret"
  const fileId = "file_secret_123"
  const payload = {
    input: [
      {
        content: [
          { image_url: imageDataUrl, type: "input_image" },
          { file_data: fileDataUrl, file_id: fileId, type: "input_file" },
        ],
        role: "user",
      },
    ],
    messages: [
      {
        content: [
          {
            image_url: {
              detail: "high",
              url: imageDataUrl,
            },
            type: "image_url",
          },
          {
            source: {
              data: "anthropic-base64-secret",
              media_type: "image/png",
              type: "base64",
            },
            type: "image",
          },
          {
            image_url: signedUrl,
            type: "input_image",
          },
        ],
        role: "user",
      },
    ],
  }

  debugJson(logger as never, "payload", payload)

  const serialized = (
    logger.debug.mock.calls as Array<Array<unknown>>
  )[0][1] as string
  expect(serialized).toContain("[redacted_media")
  expect(serialized).toContain("mime=image/png")
  expect(serialized).toContain("kind=file_id")
  expect(serialized).not.toContain(imageDataUrl)
  expect(serialized).not.toContain(fileDataUrl)
  expect(serialized).not.toContain("anthropic-base64-secret")
  expect(serialized).not.toContain(signedUrl)
  expect(serialized).not.toContain(fileId)
  expect(serialized).not.toContain(";base64,")
})

test("redactLogString redacts embedded media data URLs", () => {
  const value = `event: response.output\ndata: {"image_url":"data:image/png;base64,${"C".repeat(64)}"}`

  const redacted = redactLogString(value)

  expect(redacted).toContain("[redacted_media")
  expect(redacted).not.toContain("data:image/png")
  expect(redacted).not.toContain(";base64,")
})

test("debugLazy redacts raw string arguments", () => {
  state.verbose = true

  const logger = {
    debug: mock(() => {}),
  }

  debugLazy(logger as never, () => [
    "chunk",
    `data: {"file_data":"data:application/pdf;base64,${"D".repeat(64)}"}`,
  ])

  const raw = (logger.debug.mock.calls as Array<Array<unknown>>)[0][1] as string
  expect(raw).toContain("[redacted_media")
  expect(raw).not.toContain(";base64,")
})

test("debugJsonTail preserves tail truncation behavior", () => {
  state.verbose = true

  const logger = {
    debug: mock(() => {}),
  }
  const payload = { text: "abcdefghijklmnopqrstuvwxyz" }
  const expected = JSON.stringify(payload).slice(-10)

  debugJsonTail(logger as never, "payload", { value: payload, tailLength: 10 })

  expect(logger.debug).toHaveBeenCalledWith("payload", expected)
})
