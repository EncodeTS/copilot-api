import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"

import type { TokenizerCancellationFixtureResult } from "./fixtures/tokenizer-cancellation-child"
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url))
const cancellationFixture = fileURLToPath(
  new URL("./fixtures/tokenizer-cancellation-child.ts", import.meta.url),
)

test("Chat file IDs remain media carriers and never reach the text encoder", async () => {
  const payload = {
    messages: [
      {
        content: [{ file: { file_id: "file_123" }, type: "file" }],
        role: "user",
      },
    ],
    model: "gpt-5",
  } satisfies ChatCompletionsPayload
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `
        import { getTokenCount } from "./src/lib/tokenizer.ts"
        const payload = ${JSON.stringify(payload)}
        const model = {
          capabilities: { tokenizer: "o200k_base" },
          id: "gpt-5",
        }
        console.log(JSON.stringify(await getTokenCount(payload, model)))
      `,
    ],
    {
      cwd: repositoryRoot,
      stderr: "pipe",
      stdout: "pipe",
    },
  )
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ])

  expect(exitCode, stderr).toBe(0)
  expect(JSON.parse(stdout)).toEqual({ input: 7, output: 0 })
})

test("worker-backed Chat tokenization cancels deterministically when cold and warm", async () => {
  const child = Bun.spawn([process.execPath, cancellationFixture], {
    cwd: repositoryRoot,
    stderr: "pipe",
    stdout: "pipe",
  })
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ])

  expect(exitCode, stderr).toBe(0)
  expect(JSON.parse(stdout) as TokenizerCancellationFixtureResult).toEqual({
    afterColdCancellation: {
      activeJobs: 0,
      pendingCodeUnits: 0,
      pendingJobs: 0,
      queuedJobs: 0,
    },
    afterCompletion: {
      activeJobs: 0,
      pendingCodeUnits: 0,
      pendingJobs: 0,
      queuedJobs: 0,
    },
    afterWarmCancellation: {
      activeJobs: 0,
      pendingCodeUnits: 0,
      pendingJobs: 0,
      queuedJobs: 0,
    },
    coldAborted: true,
    coldPending: {
      activeJobs: 1,
      pendingCodeUnits: 9,
      pendingJobs: 1,
      queuedJobs: 0,
    },
    coldYieldCalls: 1,
    exactCount: { input: 20_003, output: 0 },
    initial: {
      activeJobs: 0,
      pendingCodeUnits: 0,
      pendingJobs: 0,
      queuedJobs: 0,
    },
    warmAborted: true,
    warmPending: {
      activeJobs: 1,
      pendingCodeUnits: 9,
      pendingJobs: 1,
      queuedJobs: 0,
    },
    warmYieldCalls: 1,
  })
})
