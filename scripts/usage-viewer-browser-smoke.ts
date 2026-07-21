import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const [viewerUrl, screenshotPath] = process.argv.slice(2)
const chromeBinary =
  process.env.CHROME_BIN
  ?? (process.platform === "darwin" ?
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  : "google-chrome")

if (!viewerUrl || !screenshotPath) {
  throw new Error("Expected a Viewer URL and screenshot output path.")
}

const portProbe = Bun.serve({ fetch: () => new Response(), port: 0 })
const debuggingPort = portProbe.port
await portProbe.stop(true)
const profileDirectory = await mkdtemp(join(tmpdir(), "usage-viewer-chrome-"))
const chrome = Bun.spawn(
  [
    chromeBinary,
    "--headless=new",
    "--disable-gpu",
    `--remote-debugging-port=${debuggingPort}`,
    `--user-data-dir=${profileDirectory}`,
    "about:blank",
  ],
  { stderr: "ignore", stdout: "ignore" },
)

async function waitForDebuggerUrl(): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const targets = (await fetch(
        `http://127.0.0.1:${debuggingPort}/json/list`,
      ).then((response) => response.json())) as Array<{
        type: string
        webSocketDebuggerUrl: string
      }>
      const page = targets.find((target) => target.type === "page")
      if (page) return page.webSocketDebuggerUrl
    } catch {
      // Chrome may still be starting.
    }
    await Bun.sleep(100)
  }
  throw new Error("Chrome DevTools endpoint did not become ready.")
}

try {
  const socket = new WebSocket(await waitForDebuggerUrl())
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true })
    socket.addEventListener("error", () => reject(new Error("CDP failed")), {
      once: true,
    })
  })

  let nextId = 1
  const pending = new Map<
    number,
    { reject: (error: Error) => void; resolve: (value: unknown) => void }
  >()
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as {
      error?: { message: string }
      id?: number
      result?: unknown
    }
    if (!message.id) return
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    if (message.error) request.reject(new Error(message.error.message))
    else request.resolve(message.result)
  })

  const call = <T>(method: string, params: object = {}): Promise<T> => {
    const id = nextId
    nextId += 1
    return new Promise<T>((resolve, reject) => {
      pending.set(id, {
        reject,
        resolve: (value) => resolve(value as T),
      })
      socket.send(JSON.stringify({ id, method, params }))
    })
  }
  const evaluate = async <T>(expression: string): Promise<T> => {
    const response = await call<{
      exceptionDetails?: unknown
      result: { value: T }
    }>("Runtime.evaluate", {
      awaitPromise: true,
      expression,
      returnByValue: true,
    })
    if (response.exceptionDetails) {
      throw new Error(`Browser evaluation failed: ${expression}`)
    }
    return response.result.value
  }

  await call("Page.enable")
  await call("Page.navigate", { url: viewerUrl })
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await evaluate<string>("document.readyState")) {
      if ((await evaluate<string>("document.readyState")) === "complete") break
    }
    await Bun.sleep(100)
  }

  const initial = await evaluate<{
    controlDisplay: string
    iconCount: number
    stylesheetCount: number
  }>(`({
    controlDisplay: getComputedStyle(document.querySelector('.control-surface')).display,
    iconCount: document.querySelectorAll('svg[data-local-icon]').length,
    stylesheetCount: document.styleSheets.length
  })`)
  await evaluate(`(async () => {
    window.fetch = async (input) => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const path = new URL(input).pathname;
      if (path === '/usage') return new Response(JSON.stringify({
        quota_snapshots: { chat: {
          entitlement: 100, percent_remaining: 40, remaining: 40, unlimited: false
        } }
      }), { headers: { 'content-type': 'application/json' } });
      return new Response('', { status: 404 });
    };
    document.querySelector('#fetch-button').click();
  })()`)
  await Bun.sleep(30)
  const loading = await evaluate<{
    animationName: string
    spinnerSize: string
  }>(
    `({
      animationName: getComputedStyle(document.querySelector('.animate-spin')).animationName,
      spinnerSize: getComputedStyle(document.querySelector('.animate-spin')).width
    })`,
  )
  await Bun.sleep(260)
  const rendered = await evaluate<{
    iconCount: number
    progressWidth: string
    quotaLayout: string
  }>(`({
    iconCount: document.querySelectorAll('svg[data-local-icon]').length,
    progressWidth: getComputedStyle(document.querySelector('.progress-bar-fg')).width,
    quotaLayout: getComputedStyle(document.querySelector('.metric-grid')).display
  })`)
  const screenshot = await call<{ data: string }>("Page.captureScreenshot", {
    format: "png",
  })
  await Bun.write(screenshotPath, Buffer.from(screenshot.data, "base64"))

  if (
    initial.controlDisplay !== "grid"
    || initial.iconCount < 1
    || initial.stylesheetCount < 2
    || loading.animationName === "none"
    || loading.spinnerSize === "auto"
    || rendered.progressWidth === "0px"
    || rendered.quotaLayout !== "grid"
    || rendered.iconCount < 2
  ) {
    throw new Error(JSON.stringify({ initial, loading, rendered }))
  }
  console.log(JSON.stringify({ initial, loading, rendered, screenshotPath }))
  socket.close()
} finally {
  chrome.kill()
  await chrome.exited
  await rm(profileDirectory, { force: true, recursive: true })
}
