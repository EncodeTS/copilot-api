import fs from "node:fs"
import path from "node:path"

import {
  createHermeticTestEnvironment,
  getHermeticTestPaths,
  isInsideHermeticRoot,
} from "./hermetic-paths"

const callerRoot = process.env.COPILOT_API_CALLER_ROOT
if (!callerRoot) throw new Error("Missing COPILOT_API_CALLER_ROOT")

const paths = getHermeticTestPaths()
if (path.resolve(paths.root) === path.resolve(callerRoot)) {
  throw new Error("Test preload kept the caller-owned root")
}
for (const [name, expected] of Object.entries(
  createHermeticTestEnvironment(paths, {}),
)) {
  if (process.env[name] !== expected) {
    throw new Error(`Unexpected hermetic environment path: ${name}`)
  }
}

const { getConfig } = await import("../../src/lib/config")
const { getVSCodeDeviceId } = await import("../../src/lib/deviceid")
const { createHandlerLogStorage } = await import(
  "../../src/lib/handler-log-storage"
)
const { getHandlerLogDirectory } = await import("../../src/lib/logger")
const { ensurePaths, PATHS } = await import("../../src/lib/paths")
const { closeUsageStore, getTokenUsageEventsPage, recordTokenUsageEvent } =
  await import("../../src/lib/token-usage")

await ensurePaths()
getConfig()

const storage = createHandlerLogStorage({
  logDirectory: getHandlerLogDirectory(),
  startTimers: false,
})
storage.append(path.join(storage.logDirectory, "probe.log"), "probe-event")
await storage.close()

recordTokenUsageEvent({
  endpoint: "responses",
  input_tokens: 2,
  model: "fixture-model",
  output_tokens: 1,
  source: "copilot",
})
await getTokenUsageEventsPage({ page: 1, pageSize: 1, period: "day" })
await closeUsageStore()

const deviceId = paths.deviceId ? await getVSCodeDeviceId() : undefined
const createdFiles = [
  PATHS.CONFIG_PATH,
  PATHS.GITHUB_TOKEN_PATH,
  paths.database,
  ...listFiles(paths.logs),
  ...(paths.deviceId ? [paths.deviceId] : []),
]

for (const file of createdFiles) {
  if (!isInsideHermeticRoot(paths.root, file)) {
    throw new Error(`Path escaped hermetic root: ${file}`)
  }
  if (!fs.statSync(file).isFile()) throw new Error(`Expected file: ${file}`)
}
if (paths.deviceId && fs.readFileSync(paths.deviceId, "utf8") !== deviceId) {
  throw new Error("Persisted device id does not match the returned id")
}

process.stdout.write(
  JSON.stringify({ createdFiles, deviceId, root: paths.root }),
)

function listFiles(directory: string): Array<string> {
  return fs
    .readdirSync(directory, { recursive: true })
    .map((entry) => path.join(directory, entry.toString()))
    .filter((entry) => fs.statSync(entry).isFile())
}
