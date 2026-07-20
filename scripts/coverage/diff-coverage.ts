import { existsSync, readFileSync } from "node:fs"
import { isAbsolute, join, relative, sep } from "node:path"

import { runGit } from "../lib/git"

export interface CoverageInput {
  path: string
  sourcePrefix: string
}

export interface DiffCoverageOptions {
  base: string
  coverage: CoverageInput[]
  repository: string
  threshold: number
}

export interface FileDiffCoverage {
  coveredLines: number
  file: string
  instrumentedLines: number
  percentage: number
}

export interface DiffCoverageResult {
  coveredLines: number
  failures: string[]
  files: FileDiffCoverage[]
  instrumentedLines: number
  passed: boolean
  percentage: number
  threshold: number
}

interface ParsedCoverage {
  files: Map<string, Map<number, number>>
  failures: string[]
}

interface ChangedProductionFile {
  file: string
  patchPaths: string[]
  requiresWholeFileAdmission: boolean
}

type CoverageDomain = "desktop" | "root"

const productionExtensions = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
])

function asGitRepositoryPath(path: string): string {
  return path.replace(/^\.\//, "")
}

function asFilesystemRepositoryPath(path: string): string {
  return (sep === "\\" ? path.replaceAll("\\", "/") : path).replace(/^\.\//, "")
}

function extensionOf(path: string): string {
  const basename = path.slice(path.lastIndexOf("/") + 1)
  const dot = basename.lastIndexOf(".")
  return dot === -1 ? "" : basename.slice(dot)
}

function isGeneratedOrDeclaration(path: string): boolean {
  const normalizedPath = asGitRepositoryPath(path)
  const basename = normalizedPath.slice(normalizedPath.lastIndexOf("/") + 1)

  return (
    /\.d\.[cm]?tsx?$/.test(basename)
    || /\.(?:generated|gen)\.[cm]?[jt]sx?$/.test(basename)
    || /(?:^|\/)(?:__generated__|generated)(?:\/|$)/.test(normalizedPath)
  )
}

function productionCoverageDomain(path: string): CoverageDomain | undefined {
  const normalizedPath = asGitRepositoryPath(path)
  if (
    !productionExtensions.has(extensionOf(normalizedPath))
    || isGeneratedOrDeclaration(normalizedPath)
  ) {
    return undefined
  }
  if (normalizedPath.startsWith("src/")) {
    return "root"
  }
  if (
    normalizedPath.startsWith("desktop/electron/")
    || normalizedPath.startsWith("desktop/src/")
  ) {
    return "desktop"
  }
  return undefined
}

export function isProductionSource(path: string): boolean {
  return productionCoverageDomain(path) !== undefined
}

function validateBase(repository: string, base: string): void {
  if (!/^[0-9a-f]{7,40}$/i.test(base)) {
    throw new Error("--base must be an explicit Git commit SHA")
  }

  runGit(repository, ["cat-file", "-e", `${base}^{commit}`])
}

function listChangedProductionFiles(
  repository: string,
  base: string,
): ChangedProductionFile[] {
  const output = runGit(repository, [
    "diff",
    "--text",
    "--name-status",
    "-z",
    "--find-renames",
    "--find-copies-harder",
    "--diff-filter=ACMR",
    `${base}...HEAD`,
  ])
  const fields = output.split("\0")
  if (fields.at(-1) === "") {
    fields.pop()
  }
  const changedFiles: ChangedProductionFile[] = []

  for (let index = 0; index < fields.length; ) {
    const status = fields[index++]
    if (!status) {
      throw new Error("git diff returned an empty name-status field")
    }

    const statusKind = status[0]
    const oldPath = fields[index++]
    if (!oldPath) {
      throw new Error(`git diff returned no path for status ${status}`)
    }

    if (statusKind === "R" || statusKind === "C") {
      const newPath = fields[index++]
      if (!newPath) {
        throw new Error(`git diff returned no destination for status ${status}`)
      }
      const oldFile = asGitRepositoryPath(oldPath)
      const file = asGitRepositoryPath(newPath)
      const newDomain = productionCoverageDomain(file)
      if (newDomain) {
        const preservesSourceHistory =
          statusKind === "R" && productionCoverageDomain(oldFile) === newDomain
        changedFiles.push({
          file,
          patchPaths: preservesSourceHistory ? [oldFile, file] : [file],
          requiresWholeFileAdmission: !preservesSourceHistory,
        })
      }
      continue
    }

    const file = asGitRepositoryPath(oldPath)
    if (isProductionSource(file)) {
      changedFiles.push({
        file,
        patchPaths: [file],
        requiresWholeFileAdmission: false,
      })
    }
  }

  return changedFiles
}

function parseChangedLinesForFile(
  repository: string,
  base: string,
  patchPaths: string[],
): Set<number> {
  const output = runGit(repository, [
    "--literal-pathspecs",
    "diff",
    "--text",
    "--unified=0",
    "--no-color",
    "--no-ext-diff",
    "--find-renames",
    "--find-copies-harder",
    "--diff-filter=ACMR",
    `${base}...HEAD`,
    "--",
    ...patchPaths,
  ])
  const changedLines = new Set<number>()

  for (const line of output.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (!hunk) {
      continue
    }

    const start = Number(hunk[1])
    const count = hunk[2] === undefined ? 1 : Number(hunk[2])

    for (let offset = 0; offset < count; offset += 1) {
      changedLines.add(start + offset)
    }
  }

  return changedLines
}

function resolveLcovSource(
  repository: string,
  sourcePrefix: string,
  source: string,
): string {
  const absoluteSource =
    isAbsolute(source) ? source : join(repository, sourcePrefix, source)
  return asFilesystemRepositoryPath(relative(repository, absoluteSource))
}

function parseLcov(options: DiffCoverageOptions): ParsedCoverage {
  const files = new Map<string, Map<number, number>>()
  const failures: string[] = []

  for (const input of options.coverage) {
    if (!existsSync(input.path)) {
      failures.push(`coverage file does not exist: ${input.path}`)
      continue
    }

    let currentFile: string | undefined
    for (const line of readFileSync(input.path, "utf8").split(/\r?\n/)) {
      if (line.startsWith("SF:")) {
        currentFile = resolveLcovSource(
          options.repository,
          input.sourcePrefix,
          line.slice("SF:".length),
        )
        if (!files.has(currentFile)) {
          files.set(currentFile, new Map())
        }
        continue
      }

      if (line === "end_of_record") {
        currentFile = undefined
        continue
      }

      if (!currentFile || !line.startsWith("DA:")) {
        continue
      }

      const [lineNumberText, hitsText] = line.slice("DA:".length).split(",")
      const lineNumber = Number(lineNumberText)
      const hits = Number(hitsText)
      if (!Number.isInteger(lineNumber) || !Number.isFinite(hits)) {
        continue
      }

      const fileCoverage = files.get(currentFile)
      if (!fileCoverage) {
        continue
      }
      fileCoverage.set(
        lineNumber,
        Math.max(fileCoverage.get(lineNumber) ?? 0, hits),
      )
    }
  }

  return { failures, files }
}

function percentage(covered: number, instrumented: number): number {
  return instrumented === 0 ? 100 : (covered / instrumented) * 100
}

export function checkDiffCoverage(
  options: DiffCoverageOptions,
): DiffCoverageResult {
  if (
    !Number.isFinite(options.threshold)
    || options.threshold < 0
    || options.threshold > 100
  ) {
    throw new Error("--threshold must be between 0 and 100")
  }
  if (options.coverage.length === 0) {
    throw new Error("at least one coverage input is required")
  }

  validateBase(options.repository, options.base)
  const changedFiles = listChangedProductionFiles(
    options.repository,
    options.base,
  )
  const parsedCoverage = parseLcov(options)
  const failures = [...parsedCoverage.failures]
  const files: FileDiffCoverage[] = []

  for (const changedFile of changedFiles) {
    const { file } = changedFile
    const coverage = parsedCoverage.files.get(file)
    if (!coverage) {
      failures.push(
        `changed production file is missing from coverage: ${JSON.stringify(file)}`,
      )
      continue
    }

    const changedLines = parseChangedLinesForFile(
      options.repository,
      options.base,
      changedFile.patchPaths,
    )
    const instrumentedChangedLines = [...changedLines].filter((line) =>
      coverage.has(line),
    )
    if (
      changedFile.requiresWholeFileAdmission
      && changedLines.size > 0
      && instrumentedChangedLines.length === 0
    ) {
      failures.push(
        `whole-file production target has no instrumented changed lines: ${JSON.stringify(file)}`,
      )
    }
    const coveredLines = instrumentedChangedLines.filter(
      (line) => (coverage.get(line) ?? 0) > 0,
    ).length
    files.push({
      coveredLines,
      file,
      instrumentedLines: instrumentedChangedLines.length,
      percentage: percentage(coveredLines, instrumentedChangedLines.length),
    })
  }

  const coveredLines = files.reduce(
    (total, file) => total + file.coveredLines,
    0,
  )
  const instrumentedLines = files.reduce(
    (total, file) => total + file.instrumentedLines,
    0,
  )
  const totalPercentage = percentage(coveredLines, instrumentedLines)

  if (totalPercentage < options.threshold) {
    failures.push(
      `diff coverage ${totalPercentage.toFixed(2)}% is below required ${options.threshold.toFixed(2)}%`,
    )
  }

  return {
    coveredLines,
    failures,
    files,
    instrumentedLines,
    passed: failures.length === 0,
    percentage: totalPercentage,
    threshold: options.threshold,
  }
}
