import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

import {
  createHermeticTestEnvironment,
  createHermeticTestPaths,
} from "./fixtures/hermetic-paths"

test("MCP stdio bridge supports the patched SDK and Zod validation", async () => {
  const env: Record<string, string> = {}
  const environment = createHermeticTestEnvironment(
    createHermeticTestPaths("copilot-api-mcp-stdio-"),
  )
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined) env[key] = value
  }

  const client = new Client({ name: "mcp-stdio-test", version: "1.0.0" })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/main.ts", "mcp"],
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env,
    stderr: "pipe",
  })

  try {
    await client.connect(transport, { timeout: 5_000 })
    expect(client.getServerVersion()).toEqual({
      name: "tool_search",
      version: "1.0.0",
    })

    const { tools } = await client.listTools()
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({
      name: "search",
      inputSchema: {
        type: "object",
        properties: { names: { type: "string" } },
        required: ["names"],
      },
      _meta: { "anthropic/alwaysLoad": true },
    })

    const result = await client.callTool({
      name: "search",
      arguments: { names: "mcp__fetch__fetch, TaskList, TaskList" },
    })
    expect(result.isError).not.toBe(true)
    expect(result.content).toEqual([
      {
        type: "text",
        text: JSON.stringify({
          type: "copilot_api_tool_search",
          names: ["mcp__fetch__fetch", "TaskList"],
        }),
      },
    ])

    const invalid = await client.callTool({
      name: "search",
      arguments: { names: 123 },
    })
    expect(invalid.isError).toBe(true)
    expect(invalid.content).toMatchObject([{ type: "text" }])
    expect(JSON.stringify(invalid.content)).toContain("Input validation error")
  } finally {
    await client.close()
    await transport.close()
  }
}, 15_000)
