import { expect, test } from "bun:test"
import { once } from "node:events"
import net, { type AddressInfo, type Socket } from "node:net"

import { createStrictProxyAgentOptions } from "~/lib/proxy"

test("SOCKS5 proxy starts with a plaintext greeting before upstream TLS", async () => {
  let resolveFirstChunk: (chunk: Buffer) => void = () => {}
  const firstChunk = new Promise<Buffer>((resolve) => {
    resolveFirstChunk = resolve
  })
  const sockets = new Set<Socket>()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
    socket.once("data", (chunk: Buffer) => resolveFirstChunk(chunk))
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")

  const { port } = server.address() as AddressInfo
  const proxyOptions = createStrictProxyAgentOptions(
    `socks5://127.0.0.1:${port}`,
  )
  const child = Bun.spawn({
    cmd: [
      "node",
      "--input-type=module",
      "--eval",
      'const { ProxyAgent, request } = await import("undici"); const agent = new ProxyAgent(JSON.parse(process.env.PROXY_OPTIONS)); await request("https://upstream.invalid/", { dispatcher: agent, signal: AbortSignal.timeout(1000) }).catch(() => undefined); await agent.close();',
    ],
    cwd: process.cwd(),
    env: {
      ...process.env,
      PROXY_OPTIONS: JSON.stringify(proxyOptions),
    },
    stderr: "pipe",
    stdout: "pipe",
  })

  try {
    const chunk = await Promise.race([
      firstChunk,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("SOCKS5 greeting timed out")), 2_000),
      ),
    ])
    expect([...chunk.subarray(0, 3)]).toEqual([0x05, 0x01, 0x00])
  } finally {
    for (const socket of sockets) socket.destroy()
    server.close()
    await once(server, "close")
    if (child.exitCode === null) child.kill()
    await child.exited
  }
})
