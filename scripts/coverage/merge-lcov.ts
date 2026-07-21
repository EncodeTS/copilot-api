#!/usr/bin/env bun

import { readFileSync, writeFileSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { sep } from "node:path"

type LcovSourceSeparator = "/" | "\\"

const nativeLcovSourceSeparator: LcovSourceSeparator = sep === "\\" ? "\\" : "/"

function normalizeLcovSource(
  source: string,
  sourceSeparator: LcovSourceSeparator,
): string {
  return sourceSeparator === "\\" ? source.replaceAll("\\", "/") : source
}

function mergeLcovContents(
  inputs: string[],
  lastInputSources?: Set<string>,
): string {
  if (lastInputSources && inputs.length > 0) {
    const lastIndex = inputs.length - 1
    inputs = inputs.map((input, index) =>
      index === lastIndex ? filterLcovSources(input, lastInputSources) : input,
    )
  }
  return `${inputs
    .map((input) => input.trim())
    .filter(Boolean)
    .join("\n")}\n`
}

export async function mergeLcovFiles(
  outputPath: string,
  inputPaths: string[],
  lastInputSources?: Set<string>,
): Promise<void> {
  if (inputPaths.length === 0) {
    throw new Error("merge-lcov requires at least one input file")
  }
  const inputs = await Promise.all(
    inputPaths.map(async (path) => await readFile(path, "utf8")),
  )
  await writeFile(outputPath, mergeLcovContents(inputs, lastInputSources))
}

export function mergeLcovFilesSync(
  outputPath: string,
  inputPaths: string[],
  lastInputSources?: Set<string>,
): void {
  if (inputPaths.length === 0) {
    throw new Error("merge-lcov requires at least one input file")
  }
  const inputs = inputPaths.map((path) => readFileSync(path, "utf8"))
  writeFileSync(outputPath, mergeLcovContents(inputs, lastInputSources))
}

export function filterLcovSources(
  content: string,
  sources: Set<string>,
  sourceSeparator: LcovSourceSeparator = nativeLcovSourceSeparator,
): string {
  const normalizedSources = new Set(
    [...sources].map((source) => normalizeLcovSource(source, sourceSeparator)),
  )
  return content
    .split("end_of_record")
    .map((record) => record.trim())
    .map((record) => {
      const match = /^SF:(.+)$/mu.exec(record)
      if (!match) return null
      const source = normalizeLcovSource(match[1], sourceSeparator)
      if (!normalizedSources.has(source)) return null
      return record.replace(/^SF:.+$/mu, () => `SF:${source}`)
    })
    .filter((record): record is string => record !== null)
    .map((record) => `${record}\nend_of_record`)
    .join("\n")
}

export async function runMergeLcovCli(arguments_: string[]): Promise<void> {
  const includeMarker = arguments_.indexOf("--include-from-last")
  const positional =
    includeMarker === -1 ? arguments_ : arguments_.slice(0, includeMarker)
  const includedSources =
    includeMarker === -1 ? undefined : (
      new Set(arguments_.slice(includeMarker + 1))
    )
  const [outputPath, ...inputPaths] = positional
  if (!outputPath) throw new Error("merge-lcov requires an output path")
  await mergeLcovFiles(outputPath, inputPaths, includedSources)
}

if (import.meta.main) {
  await runMergeLcovCli(Bun.argv.slice(2))
}
