import { afterEach, expect, mock, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  createHandlerLogger,
  debugJson,
  debugJsonAsync,
  debugJsonTail,
  debugLazy,
  getHandlerLogDirectory,
  redactLogString,
  redactPayloadForDebug,
} from "../src/lib/logger"
import { createHandlerLogStorage } from "../src/lib/handler-log-storage"
import { PATHS } from "../src/lib/paths"
import { requestContext } from "../src/lib/request-context"
import { state } from "../src/lib/state"

afterEach(() => {
  state.verbose = false
  delete process.env.COPILOT_API_LOG_FULL_PAYLOADS
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

test("handler logs are private on disk", () => {
  const testLogDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "copilot-api-private-logs-"),
  )
  fs.chmodSync(testLogDir, 0o755)

  try {
    const script = `
      const fs = await import("node:fs")
      const path = await import("node:path")
      const logDir = process.env.COPILOT_API_LOG_DIR
      if (!logDir) throw new Error("Missing log directory")
      const dateKey = new Date().toLocaleDateString("sv-SE")
      const existingLogs = [
        path.join(logDir, \`existing-fixture-\${dateKey}.part-0.log\`),
        path.join(logDir, \`existing-fixture-\${dateKey}.part-1.log\`),
      ]
      for (const [index, filePath] of existingLogs.entries()) {
        fs.writeFileSync(filePath, \`existing \${index}\\n\`, { mode: 0o644 })
        fs.chmodSync(filePath, 0o644)
        if ((fs.statSync(filePath).mode & 0o777) !== 0o644) {
          throw new Error("Could not create a public fixture")
        }
      }
      const { createHandlerLogger } = await import("./src/lib/logger")
      createHandlerLogger("private-fixture").warn("private.fixture")
      createHandlerLogger("existing-fixture").warn("existing.fixture")
    `
    const result = Bun.spawnSync({
      cmd: [process.execPath, "--eval", script],
      cwd: path.resolve(import.meta.dir, ".."),
      env: { ...process.env, COPILOT_API_LOG_DIR: testLogDir },
    })

    expect(result.exitCode).toBe(0)
    expect(fs.statSync(testLogDir).mode & 0o777).toBe(0o700)

    const logFiles = fs.readdirSync(testLogDir)
    const privateLogs = logFiles.filter((entry) =>
      entry.startsWith("private-fixture-"),
    )
    const existingLogs = logFiles.filter((entry) =>
      entry.startsWith("existing-fixture-"),
    )
    expect(privateLogs).toHaveLength(1)
    expect(existingLogs).toHaveLength(2)

    for (const logFile of logFiles.filter(
      (entry) =>
        entry.startsWith("private-fixture-")
        || entry.startsWith("existing-fixture-"),
    )) {
      expect(fs.statSync(path.join(testLogDir, logFile)).mode & 0o777).toBe(
        0o600,
      )
    }
  } finally {
    fs.rmSync(testLogDir, { force: true, recursive: true })
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

test("verbose payload logging defaults to a content-free structured summary", () => {
  state.verbose = true

  const logger = {
    debug: mock(() => {}),
  }
  const payload = {
    encrypted_content: "opaque-reasoning-secret",
    error: { code: "upstream_rejected", message: "private error text" },
    input: [{ content: "private tool output", type: "function_call_output" }],
    messages: [{ content: "private user prompt", role: "user" }],
    model: "claude-opus-4.8",
    output: [{ text: "private model response", type: "message" }],
    prompt: "private prompt",
    reasoning: { summary: "private reasoning" },
    signature: "opaque-signature-secret",
    tools: [{ input_schema: { type: "object" }, name: "private_tool" }],
    type: "response.completed",
  }

  debugJson(logger as never, "payload", payload)

  expect(logger.debug).toHaveBeenCalledTimes(1)
  const serialized = (
    logger.debug.mock.calls as Array<Array<unknown>>
  )[0][1] as string
  const summary = JSON.parse(serialized) as Record<string, unknown>
  expect(summary).toMatchObject({
    counts: { input: 1, messages: 1, output: 1, tools: 1 },
    errorCode: "upstream_rejected",
    eventType: "response.completed",
    kind: "payload_summary",
    model: "claude-opus-4.8",
  })
  expect(summary.byteCount).toBeNumber()
  expect(summary.byteCount).toBeGreaterThan(0)
  expect(serialized).not.toContain("private")
  expect(serialized).not.toContain("opaque-")
})

test("full payload logging requires opt-in and still protects credentials and media", () => {
  state.verbose = true
  process.env.COPILOT_API_LOG_FULL_PAYLOADS = "1"

  const logger = {
    debug: mock(() => {}),
  }
  const imageDataUrl = `data:image/png;base64,${"X".repeat(64)}`
  const payload = {
    apiKey: "test-api-key-secret",
    authorization: "Bearer test-authorization-secret",
    cookie: "session=test-cookie-secret",
    credentials: { accessToken: "test-access-token-secret" },
    input_audio: {
      data: "test-audio-base64-secret",
      format: "wav",
    },
    messages: [{ content: "diagnostic prompt text", role: "user" }],
    output: [{ text: "diagnostic response text", type: "message" }],
    private_key: "test-snake-private-key-secret",
    privateKey: "test-camel-private-key-secret",
    prompt: "diagnostic prompt text",
    source: { data: imageDataUrl, type: "base64" },
  }
  const redactedPayload = redactPayloadForDebug(payload) as Record<
    string,
    unknown
  >

  expect(redactedPayload.privateKey).toBe("[redacted_credential]")
  expect(redactedPayload.private_key).toBe("[redacted_credential]")
  expect(redactedPayload.input_audio).toBe("[redacted_media kind=input_audio ]")

  debugJson(logger as never, "payload", payload)

  const serialized = (
    logger.debug.mock.calls as Array<Array<unknown>>
  )[0][1] as string
  expect(serialized).toContain("diagnostic prompt text")
  expect(serialized).toContain("diagnostic response text")
  expect(serialized).toContain("[redacted_credential]")
  expect(serialized).toContain("[redacted_media")
  expect(serialized).not.toContain("test-api-key-secret")
  expect(serialized).not.toContain("test-authorization-secret")
  expect(serialized).not.toContain("test-cookie-secret")
  expect(serialized).not.toContain("test-access-token-secret")
  expect(serialized).not.toContain("test-audio-base64-secret")
  expect(serialized).not.toContain("test-snake-private-key-secret")
  expect(serialized).not.toContain("test-camel-private-key-secret")
  expect(serialized).not.toContain(imageDataUrl)
})

test("full payload logging redacts credentials embedded in raw strings", () => {
  state.verbose = true
  process.env.COPILOT_API_LOG_FULL_PAYLOADS = "1"

  const logger = {
    debug: mock(() => {}),
  }
  debugLazy(logger as never, () => [
    "raw.response",
    'Authorization: Bearer test-bearer-secret\nCookie: session=test-cookie-secret\n{"apiKey":"test-json-secret","clientSecret":"test-client-secret","file_id":"file-test-secret","image_url":"https://private.example.test/image.png"}',
  ])

  const serialized = (
    logger.debug.mock.calls as Array<Array<unknown>>
  )[0][1] as string
  expect(serialized).toContain("[redacted_credential]")
  expect(serialized).not.toContain("test-bearer-secret")
  expect(serialized).not.toContain("test-cookie-secret")
  expect(serialized).not.toContain("test-json-secret")
  expect(serialized).not.toContain("test-client-secret")
  expect(serialized).not.toContain("file-test-secret")
  expect(serialized).not.toContain("private.example.test")
  expect(serialized).toContain("[redacted_media")
})

test("raw JSON redaction handles apostrophes and escaped matching quotes", () => {
  const raw =
    '{"token":"owner\'s-test-token-secret","apiKey":"escaped \\"test-api-secret\\" tail","image_url":"https://private.example.test/o\'neil.png?sig=test-media-secret"}'
  const singleQuotedRaw =
    "{'token':'escaped \\'test-single-token-secret\\' tail'}"

  const redacted = redactLogString(raw)
  const singleQuotedRedacted = redactLogString(singleQuotedRaw)

  expect(redacted).toContain('"token":"[redacted_credential]"')
  expect(redacted).toContain('"apiKey":"[redacted_credential]"')
  expect(redacted).toContain('"image_url":"[redacted_media kind=json_field]"')
  expect(redacted).not.toContain("test-token-secret")
  expect(redacted).not.toContain("test-api-secret")
  expect(redacted).not.toContain("private.example.test")
  expect(redacted).not.toContain("test-media-secret")
  expect(singleQuotedRedacted).toContain("'token':'[redacted_credential]'")
  expect(singleQuotedRedacted).not.toContain("test-single-token-secret")
})

test("handler file reporter summarizes direct payload arguments by default", () => {
  const testLogDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "copilot-api-summary-logs-"),
  )

  try {
    const script = [
      'const { createHandlerLogger } = await import("./src/lib/logger")',
      'const { state } = await import("./src/lib/state")',
      "state.verbose = true",
      'const logger = createHandlerLogger("summary-fixture")',
      'logger.debug("direct.payload", { messages: [{ content: "private prompt" }], model: "test-model", type: "request.received" })',
      'logger.error("direct.error", { data: "private tool output", error: { code: "upstream_rejected", message: "private upstream text" } })',
    ].join("; ")
    const result = Bun.spawnSync({
      cmd: [process.execPath, "--eval", script],
      cwd: path.resolve(import.meta.dir, ".."),
      env: { ...process.env, COPILOT_API_LOG_DIR: testLogDir },
    })
    expect(result.exitCode).toBe(0)

    const logFile = fs
      .readdirSync(testLogDir)
      .find((entry) => entry.startsWith("summary-fixture-"))
    expect(logFile).toBeString()
    if (!logFile) throw new Error("Expected summary handler log")
    const contents = fs.readFileSync(path.join(testLogDir, logFile), "utf8")

    expect(contents).toContain("direct.payload")
    expect(contents).toContain("direct.error")
    expect(contents).toContain("payload_summary")
    expect(contents).toContain("upstream_rejected")
    expect(contents).not.toContain("private prompt")
    expect(contents).not.toContain("private tool output")
    expect(contents).not.toContain("private upstream text")
  } finally {
    fs.rmSync(testLogDir, { force: true, recursive: true })
  }
})

test("debugJson writes its structured summary to the handler log", () => {
  const testLogDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "copilot-api-debug-summary-logs-"),
  )

  try {
    const script = [
      'const { createHandlerLogger, debugJson } = await import("./src/lib/logger")',
      'const { state } = await import("./src/lib/state")',
      "state.verbose = true",
      'const logger = createHandlerLogger("debug-summary-fixture")',
      'debugJson(logger, "request.received", { messages: [{ content: "private prompt" }], model: "helper-model", type: "request.received" })',
    ].join("; ")
    const result = Bun.spawnSync({
      cmd: [process.execPath, "--eval", script],
      cwd: path.resolve(import.meta.dir, ".."),
      env: { ...process.env, COPILOT_API_LOG_DIR: testLogDir },
    })
    expect(result.exitCode).toBe(0)

    const logFile = fs
      .readdirSync(testLogDir)
      .find((entry) => entry.startsWith("debug-summary-fixture-"))
    expect(logFile).toBeString()
    if (!logFile) throw new Error("Expected debug summary handler log")
    const contents = fs.readFileSync(path.join(testLogDir, logFile), "utf8")

    expect(contents).toContain("payload_summary")
    expect(contents).toContain("helper-model")
    expect(contents).toContain("messages: 1")
    expect(contents).not.toContain("private prompt")
  } finally {
    fs.rmSync(testLogDir, { force: true, recursive: true })
  }
})

test("handler logger emits safe summaries through injected storage", async () => {
  const logDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "copilot-api-injected-logger-"),
  )
  const storage = createHandlerLogStorage({
    logDirectory,
    startTimers: false,
  })
  state.verbose = true

  const circular: Record<string, unknown> = { type: "cycle.event" }
  circular.self = circular
  const logger = createHandlerLogger("  Weird Name!!!  ", { storage })
  const validSummary = JSON.stringify({
    byteCount: 42,
    counts: { input: 1, messages: -1, output: 1.5, tools: "2" },
    errorCode: 429,
    eventType: "response.completed",
    kind: "payload_summary",
    model: "test/model",
    private: "must-not-survive",
  })

  try {
    requestContext.run(
      {
        parentSessionId: undefined,
        sessionAffinity: undefined,
        startTime: Date.now(),
        traceId: "trace-test",
        userAgent: "test",
      },
      () =>
        logger.warn(
          "event\nlabel",
          validSummary,
          "{not-json",
          '{"byteCount":-1,"kind":"payload_summary"}',
          7,
          true,
          null,
          circular,
        ),
    )
    createHandlerLogger("!!!", { storage }).warn("")
    await storage.flush()

    const dateKey = new Date().toLocaleDateString("sv-SE")
    const contents = fs.readFileSync(
      path.join(logDirectory, `weird-name-${dateKey}.part-0.log`),
      "utf8",
    )
    expect(contents).toContain("event label")
    expect(contents).toContain("[trace-test]")
    expect(contents).toContain("payload_summary")
    expect(contents).toContain("input: 1")
    expect(contents).toContain("errorCode: 429")
    expect(contents).toContain("string_summary")
    expect(contents).toContain("cycle.event")
    expect(contents).not.toContain("must-not-survive")
    expect(contents).not.toContain("byteCount: -1")
    expect(
      fs.existsSync(path.join(logDirectory, `handler-${dateKey}.part-0.log`)),
    ).toBeTrue()
  } finally {
    await storage.close()
    fs.rmSync(logDirectory, { force: true, recursive: true })
  }
})

test("handler logs rotate before a file exceeds its byte limit", () => {
  const testLogDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "copilot-api-rotation-logs-"),
  )

  try {
    const script = [
      'const { createHandlerLogger } = await import("./src/lib/logger")',
      'const logger = createHandlerLogger("rotation-fixture")',
      'for (let index = 0; index < 40; index += 1) logger.warn("rotation.event", { index, payload: "private payload text" })',
    ].join("; ")
    const result = Bun.spawnSync({
      cmd: [process.execPath, "--eval", script],
      cwd: path.resolve(import.meta.dir, ".."),
      env: {
        ...process.env,
        COPILOT_API_LOG_DIR: testLogDir,
        COPILOT_API_LOG_MAX_FILE_BYTES: "512",
        COPILOT_API_LOG_MAX_TOTAL_BYTES: "4096",
      },
    })
    expect(result.exitCode).toBe(0)

    const files = fs
      .readdirSync(testLogDir)
      .filter((entry) => entry.startsWith("rotation-fixture-"))
    expect(files.length).toBeGreaterThan(1)
    for (const file of files) {
      expect(fs.statSync(path.join(testLogDir, file)).size).toBeLessThanOrEqual(
        512,
      )
    }
  } finally {
    fs.rmSync(testLogDir, { force: true, recursive: true })
  }
})

test("rotated handler log segments remain valid UTF-8", () => {
  const testLogDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "copilot-api-utf8-rotation-logs-"),
  )

  try {
    const script = [
      'const { createHandlerLogger } = await import("./src/lib/logger")',
      'const { state } = await import("./src/lib/state")',
      "state.verbose = true",
      'const logger = createHandlerLogger("utf8-rotation-fixture")',
      'logger.warn("rotation.utf8", { text: "你".repeat(400) })',
    ].join("; ")
    const result = Bun.spawnSync({
      cmd: [process.execPath, "--eval", script],
      cwd: path.resolve(import.meta.dir, ".."),
      env: {
        ...process.env,
        COPILOT_API_LOG_DIR: testLogDir,
        COPILOT_API_LOG_FULL_PAYLOADS: "1",
        COPILOT_API_LOG_MAX_FILE_BYTES: "256",
        COPILOT_API_LOG_MAX_TOTAL_BYTES: "4096",
      },
    })
    expect(result.exitCode).toBe(0)

    const files = fs
      .readdirSync(testLogDir)
      .filter((entry) => entry.startsWith("utf8-rotation-fixture-"))
    expect(files.length).toBeGreaterThan(1)
    for (const file of files) {
      const bytes = fs.readFileSync(path.join(testLogDir, file))
      expect(() =>
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      ).not.toThrow()
    }
  } finally {
    fs.rmSync(testLogDir, { force: true, recursive: true })
  }
})

test("handler log cleanup applies retention and budget only to managed files", () => {
  const testLogDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "copilot-api-budget-logs-"),
  )
  const dateKey = new Date().toLocaleDateString("sv-SE")
  const fixtures = [
    `oldest-handler-${dateKey}.part-0.log`,
    `middle-handler-${dateKey}.part-0.log`,
    `newest-handler-${dateKey}.part-0.log`,
  ]
  const protectedAuditLog = "private-audit.log"
  const protectedLegacyLog = `legacy-handler-${dateKey}.log`
  const expiredManagedLog = `expired-handler-${dateKey}.part-0.log`
  const now = Date.now()
  for (const [index, fixture] of fixtures.entries()) {
    const filePath = path.join(testLogDir, fixture)
    fs.writeFileSync(filePath, "x".repeat(400), { mode: 0o600 })
    const modifiedAt = new Date(now - (fixtures.length - index) * 60_000)
    fs.utimesSync(filePath, modifiedAt, modifiedAt)
  }
  const protectedAuditPath = path.join(testLogDir, protectedAuditLog)
  fs.writeFileSync(protectedAuditPath, "audit".repeat(200), { mode: 0o600 })
  const legacyModifiedAt = new Date(now - 30 * 24 * 60 * 60 * 1000)
  fs.utimesSync(protectedAuditPath, legacyModifiedAt, legacyModifiedAt)
  const protectedLegacyPath = path.join(testLogDir, protectedLegacyLog)
  fs.writeFileSync(protectedLegacyPath, "legacy".repeat(200), { mode: 0o600 })
  fs.utimesSync(protectedLegacyPath, legacyModifiedAt, legacyModifiedAt)
  const expiredManagedPath = path.join(testLogDir, expiredManagedLog)
  fs.writeFileSync(expiredManagedPath, "expired".repeat(100), { mode: 0o600 })
  fs.utimesSync(expiredManagedPath, legacyModifiedAt, legacyModifiedAt)

  try {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "--eval",
        'const { createHandlerLogger } = await import("./src/lib/logger"); createHandlerLogger("budget-fixture").warn("budget.event");',
      ],
      cwd: path.resolve(import.meta.dir, ".."),
      env: {
        ...process.env,
        COPILOT_API_LOG_DIR: testLogDir,
        COPILOT_API_LOG_MAX_FILE_BYTES: "512",
        COPILOT_API_LOG_MAX_TOTAL_BYTES: "1024",
      },
    })
    expect(result.exitCode).toBe(0)

    const files = fs.readdirSync(testLogDir)
    const managedFiles = files.filter((entry) => entry.includes(".part-"))
    const totalBytes = managedFiles.reduce(
      (total, entry) => total + fs.statSync(path.join(testLogDir, entry)).size,
      0,
    )
    expect(totalBytes).toBeLessThanOrEqual(1024)
    expect(files).not.toContain(fixtures[0])
    expect(files).toContain(fixtures[1])
    expect(files).toContain(fixtures[2])
    expect(files).toContain(protectedAuditLog)
    expect(files).toContain(protectedLegacyLog)
    expect(files).not.toContain(expiredManagedLog)
  } finally {
    fs.rmSync(testLogDir, { force: true, recursive: true })
  }
})

test("debugJson logs the serialized payload when full payload logging is enabled", () => {
  state.verbose = true
  process.env.COPILOT_API_LOG_FULL_PAYLOADS = "1"

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

test("debugJsonAsync reads and logs when full payload logging is enabled", async () => {
  state.verbose = true
  process.env.COPILOT_API_LOG_FULL_PAYLOADS = "1"

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
  process.env.COPILOT_API_LOG_FULL_PAYLOADS = "1"

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
  process.env.COPILOT_API_LOG_FULL_PAYLOADS = "1"

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
