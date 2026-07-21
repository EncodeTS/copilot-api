const sourceDistArgument = "--copilot-api-zstd-source-dist="

export function buildElectronZstdSmokeArguments(electronScript, sourceDist) {
  if (!sourceDist) {
    throw new Error("Electron zstd smoke source dist must not be empty")
  }
  return ["--no-sandbox", electronScript, `${sourceDistArgument}${sourceDist}`]
}

export function parseElectronZstdSmokeSourceDist(argv) {
  const matches = argv.filter((argument) =>
    argument.startsWith(sourceDistArgument),
  )
  if (matches.length !== 1) {
    throw new Error(
      "Electron zstd smoke requires exactly one named source dist argument",
    )
  }
  const sourceDist = matches[0].slice(sourceDistArgument.length)
  if (!sourceDist) {
    throw new Error("Electron zstd smoke source dist must not be empty")
  }
  return sourceDist
}
