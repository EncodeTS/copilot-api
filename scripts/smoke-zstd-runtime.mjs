#!/usr/bin/env node

import path from "node:path"
import { pathToFileURL } from "node:url"

import {
  createIsolatedRuntimeEnvironment,
  runZstdWorkerContract,
} from "./lib/zstd-worker-harness.mjs"

const distDir = path.resolve(process.argv[2] ?? "dist")
const workerUrl = pathToFileURL(path.join(distDir, "zstd-worker.js"))
const isolated = createIsolatedRuntimeEnvironment(
  `zstd-runtime-${process.version}`,
)
Object.assign(process.env, isolated.environment)
const result = await runZstdWorkerContract({ workerUrl })

if (!result.capPlusOneFailedClosed || !result.capZeroRejectedNonEmpty) {
  throw new Error("zstd worker did not fail closed at the decoded cap")
}

console.log(`nodeVersion=${process.version}`)
console.log(`decoder=${result.decoder}`)
console.log(`decodedBytes=${result.decodedBytes}`)
console.log(`emptyDecodedBytes=${result.emptyDecodedBytes}`)
console.log(`maxEmittedChunkBytes=${result.maxEmittedChunkBytes}`)
console.log("capPlusOneFailedClosed=true")
console.log("capZeroRejectedNonEmpty=true")
console.log(
  `isolatedEnvironment=${process.env.HOME?.startsWith(isolated.root) === true}`,
)
