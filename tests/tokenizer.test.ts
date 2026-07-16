import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url))

test("large repeated Chat content remains cancellable and counts every occurrence", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `
        import { getTokenCount } from "./src/lib/tokenizer.ts"

        const model = {
          id: "gpt-5",
          capabilities: { tokenizer: "o200k_base" },
        }
        await getTokenCount(
          { messages: [{ content: "warm", role: "user" }], model: model.id },
          model,
        )

        const messages = Array.from(
          { length: 4_000 },
          () => ({ content: "hello", role: "user" }),
        )
        const payload = { messages, model: model.id }
        const controller = new AbortController()
        const reason = new Error("cancel repeated tokenization")
        const timer = setTimeout(() => controller.abort(reason), 0)
        let thrown

        try {
          await getTokenCount(payload, model, { signal: controller.signal })
        } catch (error) {
          thrown = error
        } finally {
          clearTimeout(timer)
        }

        const exactCount = await getTokenCount(payload, model, {
          signal: new AbortController().signal,
        })
        console.log(JSON.stringify({ aborted: thrown === reason, exactCount }))
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
  expect(JSON.parse(stdout)).toEqual({
    aborted: true,
    exactCount: { input: 20_003, output: 0 },
  })
})
