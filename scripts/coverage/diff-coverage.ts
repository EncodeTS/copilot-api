import { existsSync } from "node:fs"
import { dirname, isAbsolute, join, relative, sep } from "node:path"
import * as ts from "typescript"

import { runGit } from "../lib/git"
import {
  type CoverageDomain,
  readVerifiedCoverageArtifact,
} from "./coverage-attestation"

export interface CoverageInput {
  attestationPath?: string
  domain?: CoverageDomain
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
  baseFile?: string
  domain: CoverageDomain
  file: string
  patchPaths: string[]
  requiresWholeFileAdmission: boolean
}

interface ChangedLineHunk {
  currentCount: number
  currentStart: number
  previousCount: number
  previousStart: number
}

interface ChangedLines {
  hunks: ChangedLineHunk[]
  lines: Set<number>
}

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
  if (normalizedPath.startsWith("scripts/release/")) {
    return "root"
  }
  if (
    normalizedPath === "scripts/check-diff-coverage.ts"
    || normalizedPath === "scripts/lib/git.ts"
    || normalizedPath.startsWith("scripts/coverage/")
  ) {
    return "root"
  }
  if (normalizedPath.startsWith("shared-types/")) {
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
  headCommit: string,
): ChangedProductionFile[] {
  const output = runGit(repository, [
    "diff",
    "--text",
    "--name-status",
    "-z",
    "--find-renames",
    "--find-copies-harder",
    "--diff-filter=ACMR",
    `${base}...${headCommit}`,
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
          baseFile: preservesSourceHistory ? oldFile : undefined,
          domain: newDomain,
          file,
          patchPaths: preservesSourceHistory ? [oldFile, file] : [file],
          requiresWholeFileAdmission: !preservesSourceHistory,
        })
      }
      continue
    }

    const file = asGitRepositoryPath(oldPath)
    const domain = productionCoverageDomain(file)
    if (domain) {
      changedFiles.push({
        baseFile: statusKind === "M" ? file : undefined,
        domain,
        file,
        patchPaths: [file],
        requiresWholeFileAdmission: statusKind === "A",
      })
    }
  }

  return changedFiles
}

function parseChangedLinesForFile(
  repository: string,
  base: string,
  headCommit: string,
  patchPaths: string[],
): ChangedLines {
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
    `${base}...${headCommit}`,
    "--",
    ...patchPaths,
  ])
  const changedLines = new Set<number>()
  const hunks: ChangedLineHunk[] = []

  for (const line of output.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (!hunk) {
      continue
    }

    const previousStart = Number(hunk[1])
    const previousCount = hunk[2] === undefined ? 1 : Number(hunk[2])
    const currentStart = Number(hunk[3])
    const currentCount = hunk[4] === undefined ? 1 : Number(hunk[4])
    hunks.push({ currentCount, currentStart, previousCount, previousStart })

    for (let offset = 0; offset < currentCount; offset += 1) {
      changedLines.add(currentStart + offset)
    }
  }

  return { hunks, lines: changedLines }
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

function parseLcov(
  options: DiffCoverageOptions,
  headCommit: string,
): ParsedCoverage {
  const files = new Map<string, Map<number, number>>()
  const failures: string[] = []

  for (const input of options.coverage) {
    if (!existsSync(input.path)) {
      failures.push(`coverage file does not exist: ${input.path}`)
      continue
    }
    const attestationPath =
      input.attestationPath ?? join(dirname(input.path), "attestation.json")
    const domain =
      input.domain ?? (input.sourcePrefix === "desktop" ? "desktop" : "root")
    const verifiedArtifact = readVerifiedCoverageArtifact(
      options.repository,
      domain,
      input.path,
      attestationPath,
      headCommit,
    )
    if (!verifiedArtifact.ok) {
      failures.push(verifiedArtifact.failure)
      continue
    }

    let currentFile: string | undefined
    for (const line of verifiedArtifact.lcov.split(/\r?\n/)) {
      if (line.startsWith("SF:")) {
        const sourceFile = resolveLcovSource(
          options.repository,
          input.sourcePrefix,
          line.slice("SF:".length),
        )
        currentFile =
          productionCoverageDomain(sourceFile) === domain ? sourceFile : (
            undefined
          )
        if (!currentFile) {
          continue
        }
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

function runtimeCompilerOptions(domain: CoverageDomain): ts.CompilerOptions {
  return {
    jsx: ts.JsxEmit.Preserve,
    module: ts.ModuleKind.Preserve,
    newLine: ts.NewLineKind.LineFeed,
    removeComments: true,
    target: ts.ScriptTarget.ESNext,
    verbatimModuleSyntax: domain === "root",
  }
}

function emittedRuntime(
  source: string,
  file: string,
  domain: CoverageDomain,
): string {
  return ts.transpileModule(source, {
    compilerOptions: runtimeCompilerOptions(domain),
    fileName: file,
    reportDiagnostics: false,
  }).outputText
}

interface SourceInterval {
  end: number
  start: number
}

const toolingDirectiveCommentPattern =
  /(?:[@#](?:__NO_SIDE_EFFECTS__|__PURE__|babel|jsx(?:Frag|ImportSource|Runtime)?|license|preserve|ts-(?:check|expect-error|ignore|nocheck)|vite-ignore)\b|(?:biome|eslint|prettier)-(?:disable|enable|ignore)\b|(?:c8|istanbul)\s+ignore\b|source(?:Mapping)?URL\s*=|webpack(?:ChunkName|Exports|Ignore|Include|Mode|Prefetch|Preload)\s*:)/i

function scriptKindForFile(file: string): ts.ScriptKind {
  switch (extensionOf(file).toLowerCase()) {
    case ".js":
    case ".cjs":
    case ".mjs":
      return ts.ScriptKind.JS
    case ".jsx":
      return ts.ScriptKind.JSX
    case ".tsx":
      return ts.ScriptKind.TSX
    default:
      return ts.ScriptKind.TS
  }
}

function runtimeSourceLineSignatures(source: string, file: string): string[] {
  const scriptKind = scriptKindForFile(file)
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  )
  const erasedIntervals: SourceInterval[] = []
  const semanticRuntimeMarkers: Array<{ position: number; value: string }> = []
  const addInterval = (start: number, end: number): void => {
    if (start < end) erasedIntervals.push({ end, start })
  }
  const addNode = (node: ts.Node): void => {
    addInterval(node.getStart(sourceFile), node.end)
  }
  const addTypeAnnotation = (type: ts.TypeNode): void => {
    let start = type.getStart(sourceFile)
    let cursor = start - 1
    while (cursor >= 0 && /\s/.test(source[cursor] ?? "")) cursor -= 1
    if (source[cursor] === ":") start = cursor
    addInterval(start, type.end)
  }
  const addBracketedNodeArray = (nodes: ts.NodeArray<ts.Node>): void => {
    if (nodes.length === 0) return
    let start = nodes[0]?.getStart(sourceFile) ?? nodes.pos
    let cursor = start - 1
    while (cursor >= 0 && /\s/.test(source[cursor] ?? "")) cursor -= 1
    if (source[cursor] === "<") start = cursor
    let end = nodes.at(-1)?.end ?? nodes.end
    cursor = end
    while (cursor < source.length && /\s/.test(source[cursor] ?? "")) {
      cursor += 1
    }
    if (source[cursor] === ">") end = cursor + 1
    addInterval(start, end)
  }
  const addTypeOnlySpecifier = (
    node: ts.ImportSpecifier | ts.ExportSpecifier,
  ): void => {
    const siblings: readonly ts.Node[] = node.parent.elements
    const index = siblings.indexOf(node)
    const previous = siblings[index - 1]
    const next = siblings[index + 1]
    if (next) {
      addInterval(node.getStart(sourceFile), next.getStart(sourceFile))
    } else if (previous) {
      addInterval(previous.end, node.end)
    } else {
      addNode(node)
    }
  }
  const hasModifier = (node: ts.Node, kind: ts.SyntaxKind): boolean =>
    ts.canHaveModifiers(node)
    && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind)
  const isAmbientNode = (node: ts.Node): boolean => {
    for (
      let current: ts.Node | undefined = node;
      current;
      current = current.parent
    ) {
      if (hasModifier(current, ts.SyntaxKind.DeclareKeyword)) return true
      if (ts.isSourceFile(current)) return current.isDeclarationFile
    }
    return false
  }
  const addRuntimeMarker = (node: ts.Node, value: string): void => {
    semanticRuntimeMarkers.push({
      position: node.getStart(sourceFile),
      value,
    })
  }

  const visit = (node: ts.Node): void => {
    if (
      ts.isModuleDeclaration(node)
      && ts
        .transpileModule(node.getText(sourceFile), {
          compilerOptions: runtimeCompilerOptions("desktop"),
          reportDiagnostics: false,
        })
        .outputText.trim().length === 0
    ) {
      addNode(node)
      return
    }
    if (
      ts.isParameter(node)
      && ts.isParameterPropertyDeclaration(node, node.parent)
    ) {
      semanticRuntimeMarkers.push({
        position: node.name.getStart(sourceFile),
        value: "parameter-property-runtime",
      })
    }
    if (
      ts.isPropertyDeclaration(node)
      && ts.isClassLike(node.parent)
      && !isAmbientNode(node)
      && !hasModifier(node, ts.SyntaxKind.AbstractKeyword)
    ) {
      addRuntimeMarker(
        node,
        `class-property-runtime:${hasModifier(node, ts.SyntaxKind.StaticKeyword) ? "static" : "instance"}:${hasModifier(node, ts.SyntaxKind.AccessorKeyword) ? "accessor" : "field"}`,
      )
    } else if (
      (ts.isMethodDeclaration(node)
        || ts.isGetAccessorDeclaration(node)
        || ts.isSetAccessorDeclaration(node))
      && node.body
      && !isAmbientNode(node)
    ) {
      addRuntimeMarker(node, "class-method-runtime")
    } else if (
      (ts.isClassDeclaration(node) || ts.isClassExpression(node))
      && !isAmbientNode(node)
    ) {
      addRuntimeMarker(node, "class-runtime")
    } else if (
      ts.isFunctionDeclaration(node)
      && node.body
      && !isAmbientNode(node)
    ) {
      addRuntimeMarker(node, "function-runtime")
    } else if (ts.isEnumDeclaration(node) && !isAmbientNode(node)) {
      addRuntimeMarker(node, "enum-runtime")
    } else if (ts.isVariableStatement(node) && !isAmbientNode(node)) {
      addRuntimeMarker(node, "variable-runtime")
    }
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause
      const namedBindings = clause?.namedBindings
      if (
        namedBindings
        && ts.isNamedImports(namedBindings)
        && namedBindings.elements.length > 0
        && namedBindings.elements.every((specifier) => specifier.isTypeOnly)
      ) {
        if (clause.name) {
          addInterval(clause.name.end, namedBindings.end)
        } else {
          addNode(node)
          return
        }
      }
    }
    if (
      ts.isExportDeclaration(node)
      && node.exportClause
      && ts.isNamedExports(node.exportClause)
      && node.exportClause.elements.length > 0
      && node.exportClause.elements.every((specifier) => specifier.isTypeOnly)
    ) {
      addNode(node)
      return
    }
    if (
      ts.isInterfaceDeclaration(node)
      || ts.isTypeAliasDeclaration(node)
      || (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly)
      || (ts.isExportDeclaration(node) && node.isTypeOnly)
    ) {
      addNode(node)
      return
    }
    if (
      (ts.isImportSpecifier(node) || ts.isExportSpecifier(node))
      && node.isTypeOnly
    ) {
      addTypeOnlySpecifier(node)
      return
    }
    if (ts.isTypeNode(node)) {
      addNode(node)
      return
    }
    if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
      addInterval(node.expression.end, node.end)
      visit(node.expression)
      return
    }
    if (ts.isTypeAssertionExpression(node)) {
      addInterval(
        node.getStart(sourceFile),
        node.expression.getStart(sourceFile),
      )
      visit(node.expression)
      return
    }
    if (ts.isNonNullExpression(node)) {
      addInterval(node.expression.end, node.end)
      visit(node.expression)
      return
    }

    const typedNode = node as ts.Node & { readonly type?: ts.TypeNode }
    if (typedNode.type && ts.isTypeNode(typedNode.type)) {
      addTypeAnnotation(typedNode.type)
    }
    const genericNode = node as ts.Node & {
      readonly typeArguments?: ts.NodeArray<ts.TypeNode>
      readonly typeParameters?: ts.NodeArray<ts.TypeParameterDeclaration>
    }
    if (genericNode.typeArguments) {
      addBracketedNodeArray(genericNode.typeArguments)
    }
    if (genericNode.typeParameters) {
      addBracketedNodeArray(genericNode.typeParameters)
    }
    const optionalNode = node as ts.Node & {
      readonly exclamationToken?: ts.ExclamationToken
      readonly questionToken?: ts.QuestionToken
    }
    if (optionalNode.exclamationToken) addNode(optionalNode.exclamationToken)
    if (optionalNode.questionToken) addNode(optionalNode.questionToken)

    if (ts.canHaveModifiers(node)) {
      for (const modifier of ts.getModifiers(node) ?? []) {
        if (
          modifier.kind === ts.SyntaxKind.AbstractKeyword
          || modifier.kind === ts.SyntaxKind.DeclareKeyword
          || modifier.kind === ts.SyntaxKind.OverrideKeyword
          || modifier.kind === ts.SyntaxKind.PrivateKeyword
          || modifier.kind === ts.SyntaxKind.ProtectedKeyword
          || modifier.kind === ts.SyntaxKind.PublicKeyword
          || modifier.kind === ts.SyntaxKind.ReadonlyKeyword
        ) {
          addNode(modifier)
        }
      }
    }
    if (ts.isClassLike(node)) {
      for (const clause of node.heritageClauses ?? []) {
        if (clause.token === ts.SyntaxKind.ImplementsKeyword) addNode(clause)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)

  erasedIntervals.sort(
    (left, right) => left.start - right.start || left.end - right.end,
  )
  const mergedIntervals: SourceInterval[] = []
  for (const interval of erasedIntervals) {
    const previous = mergedIntervals.at(-1)
    if (previous && interval.start <= previous.end) {
      previous.end = Math.max(previous.end, interval.end)
    } else {
      mergedIntervals.push({ ...interval })
    }
  }

  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    scriptKind === ts.ScriptKind.JSX || scriptKind === ts.ScriptKind.TSX ?
      ts.LanguageVariant.JSX
    : ts.LanguageVariant.Standard,
    source,
  )
  const lineSignatures: string[][] = Array.from(
    {
      length: sourceFile.getLineAndCharacterOfPosition(source.length).line + 1,
    },
    () => [],
  )
  const recordToken = (value: string, start: number, end: number): void => {
    const firstLine = sourceFile.getLineAndCharacterOfPosition(start).line
    const lastLine = sourceFile.getLineAndCharacterOfPosition(
      Math.max(start, end - 1),
    ).line
    for (let line = firstLine; line <= lastLine; line += 1) {
      lineSignatures[line]?.push(value)
    }
  }
  for (const marker of semanticRuntimeMarkers) {
    recordToken(marker.value, marker.position, marker.position + 1)
  }
  let intervalIndex = 0
  for (
    let token = scanner.scan();
    token !== ts.SyntaxKind.EndOfFileToken;
    token = scanner.scan()
  ) {
    const start = scanner.getTokenPos()
    const end = scanner.getTextPos()
    if (
      token === ts.SyntaxKind.SingleLineCommentTrivia
      || token === ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      const comment = scanner.getTokenText()
      if (toolingDirectiveCommentPattern.test(comment)) {
        recordToken(`directive:${JSON.stringify(comment)}`, start, end)
      }
      continue
    }
    if (
      token === ts.SyntaxKind.WhitespaceTrivia
      || token === ts.SyntaxKind.NewLineTrivia
    ) {
      continue
    }
    while (
      intervalIndex < mergedIntervals.length
      && (mergedIntervals[intervalIndex]?.end ?? 0) <= start
    ) {
      intervalIndex += 1
    }
    const interval = mergedIntervals[intervalIndex]
    if (interval && interval.start <= start && end <= interval.end) continue
    recordToken(
      `${token}:${JSON.stringify(scanner.getTokenText())}`,
      start,
      end,
    )
  }
  return lineSignatures.map((tokens) => tokens.join("|"))
}

function neutralChangedLines(
  hunks: ChangedLineHunk[],
  previousSource: string,
  previousFile: string,
  currentSource: string,
  currentFile: string,
): Set<number> {
  const previousLines = runtimeSourceLineSignatures(
    previousSource,
    previousFile,
  )
  const currentLines = runtimeSourceLineSignatures(currentSource, currentFile)
  const neutral = new Set<number>()

  for (const hunk of hunks) {
    const previous = Array.from(
      { length: hunk.previousCount },
      (_, index) => previousLines[hunk.previousStart - 1 + index] ?? "",
    )
    const current = Array.from(
      { length: hunk.currentCount },
      (_, index) => currentLines[hunk.currentStart - 1 + index] ?? "",
    )
    let prefix = 0
    while (
      prefix < previous.length
      && prefix < current.length
      && previous[prefix] === current[prefix]
    ) {
      neutral.add(hunk.currentStart + prefix)
      prefix += 1
    }

    let previousSuffix = previous.length - 1
    let currentSuffix = current.length - 1
    while (
      previousSuffix >= prefix
      && currentSuffix >= prefix
      && previous[previousSuffix] === current[currentSuffix]
    ) {
      neutral.add(hunk.currentStart + currentSuffix)
      previousSuffix -= 1
      currentSuffix -= 1
    }

    const remainingPrevious = previousSuffix - prefix + 1
    const remainingCurrent = currentSuffix - prefix + 1
    if (remainingPrevious === remainingCurrent) {
      for (let offset = 0; offset < remainingCurrent; offset += 1) {
        if (previous[prefix + offset] === current[prefix + offset]) {
          neutral.add(hunk.currentStart + prefix + offset)
        }
      }
    } else {
      for (let index = prefix; index <= currentSuffix; index += 1) {
        if (current[index] === "") neutral.add(hunk.currentStart + index)
      }
    }
    for (let index = 0; index < current.length; index += 1) {
      if (current[index] === "") neutral.add(hunk.currentStart + index)
    }
  }
  return neutral
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
  const headCommit = runGit(options.repository, ["rev-parse", "HEAD"]).trim()
  const changedFiles = listChangedProductionFiles(
    options.repository,
    options.base,
    headCommit,
  )
  const parsedCoverage = parseLcov(options, headCommit)
  const failures = [...parsedCoverage.failures]
  const files: FileDiffCoverage[] = []

  for (const changedFile of changedFiles) {
    const { file } = changedFile
    const currentSource = runGit(options.repository, [
      "show",
      `${headCommit}:${file}`,
    ])
    const currentRuntime = emittedRuntime(
      currentSource,
      file,
      changedFile.domain,
    )
    const baseSource =
      changedFile.baseFile ?
        runGit(options.repository, [
          "show",
          `${options.base}:${changedFile.baseFile}`,
        ])
      : undefined
    if (
      !changedFile.requiresWholeFileAdmission
      && currentRuntime.trim().length === 0
    ) {
      files.push({
        coveredLines: 0,
        file,
        instrumentedLines: 0,
        percentage: 100,
      })
      continue
    }

    const coverage = parsedCoverage.files.get(file)
    if (!coverage) {
      failures.push(
        `changed production file is missing from coverage: ${JSON.stringify(file)}`,
      )
      continue
    }
    if (coverage.size === 0) {
      failures.push(
        `changed production file has an LCOV SF record but no instrumented DA lines: ${JSON.stringify(file)}`,
      )
    }
    const currentLineCount = currentSource.split(/\r\n?|\n/).length
    const validCoverage = new Map(
      [...coverage].filter(([line]) => line >= 1 && line <= currentLineCount),
    )
    if (coverage.size > 0 && validCoverage.size === 0) {
      failures.push(
        `changed production file has no LCOV DA lines within the current source: ${JSON.stringify(file)}`,
      )
    }
    if (currentRuntime.trim().length === 0) {
      failures.push(
        `changed production source emits no runtime; use a declaration file: ${JSON.stringify(file)}`,
      )
    }

    const changedLines = parseChangedLinesForFile(
      options.repository,
      options.base,
      headCommit,
      changedFile.patchPaths,
    )
    const neutralLines =
      changedFile.baseFile && baseSource !== undefined ?
        neutralChangedLines(
          changedLines.hunks,
          baseSource,
          changedFile.baseFile,
          currentSource,
          file,
        )
      : new Set<number>()
    const instrumentedChangedLines = [...changedLines.lines].filter(
      (line) => !neutralLines.has(line) && validCoverage.has(line),
    )
    if (
      changedFile.requiresWholeFileAdmission
      && changedLines.lines.size > 0
      && instrumentedChangedLines.length === 0
    ) {
      failures.push(
        `whole-file production target has no instrumented changed lines: ${JSON.stringify(file)}`,
      )
    }
    const coveredLines = instrumentedChangedLines.filter(
      (line) => (validCoverage.get(line) ?? 0) > 0,
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
  if (runGit(options.repository, ["rev-parse", "HEAD"]).trim() !== headCommit) {
    failures.push("HEAD changed while differential coverage was running")
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
