#!/usr/bin/env bun

import { resolve } from "node:path"
import { parseArgs } from "node:util"

import { checkDiffCoverage } from "./coverage/diff-coverage"

const usage = `Usage:
  bun run test:coverage:diff -- --base <merge-base-sha> [options]

Options:
  --base <sha>            Explicit Git merge-base SHA (required)
  --threshold <percent>   Changed-line coverage threshold (default: 85)
  --root-lcov <path>      Root LCOV path (default: coverage/root/lcov.info)
  --desktop-lcov <path>   Desktop LCOV path (default: coverage/desktop/lcov.info)
  --repository <path>     Repository root (default: current directory)
  --help                  Show this help
`

export interface DiffCoverageCliOutput {
  error: (message: string) => void
  log: (message: string) => void
}

export function runDiffCoverageCli(
  arguments_: string[],
  output: DiffCoverageCliOutput = console,
): number {
  try {
    const { values } = parseArgs({
      args: arguments_,
      options: {
        base: { type: "string" },
        "desktop-lcov": { type: "string" },
        help: { type: "boolean" },
        repository: { type: "string" },
        "root-lcov": { type: "string" },
        threshold: { type: "string" },
      },
      strict: true,
    })

    if (values.help) {
      output.log(usage)
      return 0
    }
    if (!values.base) {
      throw new Error(
        "--base is required and must be an explicit merge-base SHA",
      )
    }

    const repository = resolve(values.repository ?? process.cwd())
    const threshold = Number(values.threshold ?? "85")
    const rootLcov = resolve(
      repository,
      values["root-lcov"] ?? "coverage/root/lcov.info",
    )
    const desktopLcov = resolve(
      repository,
      values["desktop-lcov"] ?? "coverage/desktop/lcov.info",
    )
    const result = checkDiffCoverage({
      base: values.base,
      coverage: [
        { path: rootLcov, sourcePrefix: "." },
        { path: desktopLcov, sourcePrefix: "desktop" },
      ],
      repository,
      threshold,
    })

    for (const file of result.files) {
      output.log(
        `${file.percentage.toFixed(2).padStart(7)}% ${String(file.coveredLines).padStart(4)}/${String(file.instrumentedLines).padEnd(4)} ${JSON.stringify(file.file)}`,
      )
    }
    output.log(
      `Diff coverage: ${result.percentage.toFixed(2)}% (${result.coveredLines}/${result.instrumentedLines} changed instrumented lines; required ${result.threshold.toFixed(2)}%)`,
    )

    for (const failure of result.failures) {
      output.error(`ERROR: ${failure}`)
    }

    return result.passed ? 0 : 1
  } catch (error) {
    output.error(
      `ERROR: ${error instanceof Error ? error.message : String(error)}`,
    )
    output.error(usage)
    return 1
  }
}

if (import.meta.main) {
  process.exitCode = runDiffCoverageCli(Bun.argv.slice(2))
}
