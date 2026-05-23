import { afterEach, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

interface TokenUsageEventsPage {
  items: Array<{
    cache_read_input_tokens: number
    endpoint: string
    input_tokens: number
    model: string
    output_tokens: number
    provider_name: string | null
    session_id: string
    source: string
    total_tokens: number
  }>
}

interface ScriptResult {
  fetchCalls: number
  page: TokenUsageEventsPage
  status: number
}

const cwd = fileURLToPath(new URL("../", import.meta.url))
const decoder = new TextDecoder()
const tempDirs: Array<string> = []
const DB_PATH_ENV = "COPILOT_API_SQLITE_DB_PATH"

function createTempDir(): string {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "copilot-api-provider-usage-"),
  )
  tempDirs.push(tempDir)
  return tempDir
}

function runScript(tempDir: string, script: string): ScriptResult {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "--eval", script],
    cwd,
    env: {
      ...process.env,
      COPILOT_API_ENTERPRISE_URL: "",
      COPILOT_API_HOME: tempDir,
      COPILOT_API_OAUTH_APP: "",
      [DB_PATH_ENV]: ":memory:",
    },
  })

  if (result.exitCode !== 0) {
    throw new Error(
      `Script failed with exit code ${result.exitCode}\nstdout:\n${decoder.decode(result.stdout)}\nstderr:\n${decoder.decode(result.stderr)}`,
    )
  }

  return JSON.parse(decoder.decode(result.stdout).trim()) as ScriptResult
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

test("records provider responses usage with session affinity", () => {
  const tempDir = createTempDir()

  const result = runScript(
    tempDir,
    `
      import fs from "node:fs"
      import path from "node:path"
      import { Hono } from "hono"

      const tempDir = process.env.COPILOT_API_HOME
      if (!tempDir) {
        throw new Error("COPILOT_API_HOME is required")
      }

      fs.writeFileSync(
        path.join(tempDir, "config.json"),
        JSON.stringify(
          {
            providers: {
              codex: {
                type: "openai-responses",
                authType: "oauth2",
                baseUrl: "https://chatgpt.com/backend-api",
              },
            },
          },
          null,
          2,
        ) + "\\n",
        "utf8",
      )

      fs.writeFileSync(
        path.join(tempDir, "codex_credentials.json"),
        JSON.stringify(
          {
            accessToken: "codex-access-token",
            refreshToken: "codex-refresh-token",
            expiresAt: Date.now() + 60 * 60 * 1000,
            accountId: "acct_test",
          },
          null,
          2,
        ) + "\\n",
        "utf8",
      )

      let fetchCalls = 0
      globalThis.fetch = async () => {
        fetchCalls += 1
        return new Response(
          JSON.stringify({
            created_at: 0,
            error: null,
            id: "resp-provider",
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
            usage: {
              input_tokens: 10,
              input_tokens_details: {
                cached_tokens: 2,
              },
              output_tokens: 3,
              total_tokens: 13,
            },
          }),
          {
            headers: {
              "content-type": "application/json",
            },
            status: 200,
          },
        )
      }

      const { traceIdMiddleware } = await import("./src/lib/trace")
      const { closeUsageStore } = await import("./src/lib/token-usage")
      const { stopCodexRefreshLoop } = await import("./src/lib/token")
      const { tokenUsageRoute } = await import("./src/routes/token-usage/route")
      const { responsesRoutes } = await import("./src/routes/responses/route")

      try {
        const app = new Hono()
        app.use("*", traceIdMiddleware)
        app.route("/v1/responses", responsesRoutes)
        app.route("/token-usage", tokenUsageRoute)

        const response = await app.request("/v1/responses", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-session-affinity": "session-affinity-1",
          },
          body: JSON.stringify({
            input: "hello",
            model: "codex/gpt-5.4",
          }),
        })

        const pageResponse = await app.request(
          "/token-usage/events?period=day&page=1&page_size=10",
        )

        console.log(
          JSON.stringify({
            fetchCalls,
            page: await pageResponse.json(),
            status: response.status,
          }),
        )
      } finally {
        stopCodexRefreshLoop()
        await closeUsageStore()
      }
    `,
  )

  expect(result.status).toBe(200)
  expect(result.fetchCalls).toBe(1)
  expect(result.page.items).toHaveLength(1)
  expect(result.page.items[0]).toMatchObject({
    cache_read_input_tokens: 2,
    endpoint: "responses",
    input_tokens: 8,
    model: "gpt-5.4",
    output_tokens: 3,
    provider_name: "codex",
    session_id: "session-affinity-1",
    source: "provider",
    total_tokens: 13,
  })
})
