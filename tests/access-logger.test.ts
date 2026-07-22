import { expect, test } from "bun:test"
import fs from "node:fs"
import { fileURLToPath } from "node:url"

import {
  createHermeticTestEnvironment,
  createHermeticTestPaths,
} from "./fixtures/hermetic-paths"
import {
  createQuerySafeAccessLogOutput,
  stripAccessLogQuery,
} from "../src/lib/access-logger"

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url))
const serverFixture = fileURLToPath(
  new URL("./fixtures/access-logger-server-child.ts", import.meta.url),
)

test("query-safe access output preserves the ordinary log grammar", () => {
  const lines: Array<string> = []
  const output = createQuerySafeAccessLogOutput((line) => lines.push(line))

  output("<-- POST /provider/v1/alpha/search?q=private&token=secret")
  output("--> POST /provider/v1/alpha/search?q=private&token=secret 503 12ms")
  output("--> GET /health 200 1ms")

  expect(lines).toEqual([
    "<-- POST /provider/v1/alpha/search",
    "--> POST /provider/v1/alpha/search 503 12ms",
    "--> GET /health 200 1ms",
  ])
  expect(stripAccessLogQuery("unstructured message?kept")).toBe(
    "unstructured message?kept",
  )
})

test("production access logs omit every query while preserving path and status", async () => {
  const paths = createHermeticTestPaths("copilot-api-access-log-")
  const child = Bun.spawn([process.execPath, serverFixture], {
    cwd: repositoryRoot,
    env: createHermeticTestEnvironment(paths),
    stderr: "pipe",
    stdout: "pipe",
  })
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ])
  fs.rmSync(paths.root, { force: true, recursive: true })

  expect(exitCode, stderr).toBe(0)
  const result = JSON.parse(stdout) as {
    accessLines: Array<string>
    statuses: [number, number]
  }
  expect(result.statuses).toEqual([404, 200])
  expect(result.accessLines).toHaveLength(4)
  expect(result.accessLines[0]).toBe("<-- POST /missing/v1/alpha/search")
  expect(result.accessLines[1]).toMatch(
    /^--> POST \/missing\/v1\/alpha\/search 404 \d+(?:ms|s)$/u,
  )
  expect(result.accessLines[2]).toBe("<-- GET /")
  expect(result.accessLines[3]).toMatch(/^--> GET \/ 200 \d+(?:ms|s)$/u)
  expect(JSON.stringify(result.accessLines)).not.toContain("private-query")
  expect(JSON.stringify(result.accessLines)).not.toContain("private-token")
  expect(JSON.stringify(result.accessLines)).not.toContain("private-probe")
})
