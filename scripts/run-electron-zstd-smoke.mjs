#!/usr/bin/env node

import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { createIsolatedRuntimeEnvironment } from "./lib/zstd-worker-harness.mjs"

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const requireFromDesktop = createRequire(
  path.join(repoRoot, "desktop", "package.json"),
)
const electronPath = requireFromDesktop("electron")
const electronScript = path.join(
  repoRoot,
  "scripts",
  "smoke-electron-zstd-utility.mjs",
)
const isolated = createIsolatedRuntimeEnvironment("electron-zstd-outer")

const child = spawn(electronPath, [electronScript, ...process.argv.slice(2)], {
  env: isolated.environment,
  stdio: "inherit",
})

const exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject)
  child.once("exit", (code, signal) => {
    if (signal) {
      reject(new Error(`Electron zstd smoke exited with signal ${signal}`))
      return
    }
    resolve(code ?? 1)
  })
})

process.exitCode = exitCode
