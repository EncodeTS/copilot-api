#!/usr/bin/env electron

import { app, utilityProcess } from "electron"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const sourceDist = path.resolve(process.argv[2] ?? path.join(repoRoot, "dist"))
const stagedNodeModules = path.join(
  repoRoot,
  "desktop",
  "build",
  "server-node_modules",
)
const serverPackage = path.join(
  repoRoot,
  "desktop",
  "build",
  "server-package.json",
)
const childScript = path.join(
  repoRoot,
  "scripts",
  "electron-zstd-utility-child.mjs",
)
const apiHome = process.env.COPILOT_API_HOME
if (
  !apiHome ||
  process.env.COPILOT_ZSTD_OUTER_ISOLATED !== "1" ||
  !process.env.HOME ||
  !process.env.XDG_CONFIG_HOME
) {
  throw new Error("Electron zstd smoke was not externally isolated")
}
const userDataPath = path.join(apiHome, "electron-user-data")
fs.mkdirSync(userDataPath, { recursive: true })
app.setPath("userData", userDataPath)

const run = async () => {
  const serverDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "copilot-api-electron-zstd-smoke-"),
  )
  fs.cpSync(sourceDist, serverDir, { recursive: true })
  fs.cpSync(stagedNodeModules, path.join(serverDir, "node_modules"), {
    recursive: true,
  })
  fs.copyFileSync(serverPackage, path.join(serverDir, "package.json"))

  const child = utilityProcess.fork(childScript, [serverDir], {
    env: process.env,
    serviceName: "copilot-api-zstd-smoke",
  })
  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Electron zstd utility-process smoke timed out"))
    }, 30_000)
    child.once("error", reject)
    child.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Electron zstd utility process exited with ${code}`))
      }
    })
    child.once("message", (message) => {
      clearTimeout(timeout)
      resolve(message)
    })
  })
  child.kill()
  if (
    result?.type !== "zstd-smoke-result" ||
    result.happy !== true ||
    result.failClosed !== true ||
    result.isolatedEnvironment !== true ||
    result.workerIsolatedEnvironment !== true ||
    app.getPath("userData") !== userDataPath
  ) {
    throw new Error(`Electron zstd smoke failed: ${JSON.stringify(result)}`)
  }

  console.log("electronUtilityProcessHappy=true")
  console.log("electronUtilityProcessFailClosed=true")
  console.log(`electronUtilityProcessDecoder=${result.decoder}`)
  console.log(`electronUtilityProcessEmptyBytes=${result.emptyDecodedBytes}`)
  console.log("electronMainIsolatedEnvironment=true")
  console.log("electronUtilityProcessIsolatedEnvironment=true")
  console.log("electronWorkerIsolatedEnvironment=true")
  console.log(`electronUserData=${app.getPath("userData")}`)
}

app
  .whenReady()
  .then(run)
  .then(() => app.exit(0))
  .catch((error) => {
    console.error(error)
    app.exit(1)
  })
