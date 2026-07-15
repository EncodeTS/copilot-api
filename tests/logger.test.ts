import { afterEach, expect, mock, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  debugJson,
  debugJsonAsync,
  debugJsonTail,
  debugLazy,
  getHandlerLogDirectory,
  redactLogString,
} from "../src/lib/logger"
import { PATHS } from "../src/lib/paths"
import { state } from "../src/lib/state"

afterEach(() => {
  state.verbose = false
})

test("Bun tests route handler logs to a temporary directory", () => {
  const configuredLogDir = process.env.COPILOT_API_LOG_DIR

  expect(configuredLogDir).toBeString()
  if (!configuredLogDir) throw new Error("Expected test log directory")
  expect(path.resolve(configuredLogDir)).toStartWith(path.resolve(os.tmpdir()))
  expect(getHandlerLogDirectory()).toBe(configuredLogDir)
})

test("production logger keeps the App log directory without a test override", () => {
  const env = { ...process.env }
  delete env.COPILOT_API_LOG_DIR
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "--eval",
      'const { getHandlerLogDirectory } = await import("./src/lib/logger"); console.log(getHandlerLogDirectory());',
    ],
    cwd: path.resolve(import.meta.dir, ".."),
    env,
  })

  expect(result.exitCode).toBe(0)
  expect(new TextDecoder().decode(result.stdout).trim()).toBe(
    path.join(PATHS.APP_DIR, "logs"),
  )
})

test("lifecycle fixture stays out of real App logs and remains console-visible", () => {
  const testLogDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "copilot-api-logger-fixture-"),
  )
  const realLogDir = path.join(PATHS.APP_DIR, "logs")
  const loggerName = `stream-lifecycle-fixture-${process.pid}-${Date.now()}`
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    COPILOT_API_LOG_DIR: testLogDir,
  }
  delete env.COPILOT_API_TEST_MODE

  try {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "--eval",
        `const { createHandlerLogger } = await import("./src/lib/logger"); createHandlerLogger(${JSON.stringify(loggerName)}, { mirrorToConsole: true }).warn("stream.lifecycle", { kind: "timeout" });`,
      ],
      cwd: path.resolve(import.meta.dir, ".."),
      env,
    })
    const output =
      new TextDecoder().decode(result.stdout)
      + new TextDecoder().decode(result.stderr)

    expect(result.exitCode).toBe(0)
    expect(output).toContain("stream.lifecycle")
    expect(
      fs.readdirSync(testLogDir).some((entry) => entry.startsWith(loggerName)),
    ).toBeTrue()
    expect(
      fs.existsSync(realLogDir)
        && fs
          .readdirSync(realLogDir)
          .some((entry) => entry.startsWith(loggerName)),
    ).toBeFalse()
  } finally {
    const resolvedTestLogDir = path.resolve(testLogDir)
    const resolvedTempDir = path.resolve(os.tmpdir())
    if (resolvedTestLogDir.startsWith(`${resolvedTempDir}${path.sep}`)) {
      fs.rmSync(resolvedTestLogDir, { force: true, recursive: true })
    }
  }
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

  await debugJsonAsync(logger as never, "payload", () =>
    Promise.resolve({ image_url: imageDataUrl }),
  )

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
