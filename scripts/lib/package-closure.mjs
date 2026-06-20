import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"))
}

function packageJsonPathFor(packageDir) {
  return path.join(packageDir, "package.json")
}

function findPackageJsonFromResolvedPath(resolvedPath, packageName) {
  let current = fs.statSync(resolvedPath).isDirectory()
    ? resolvedPath
    : path.dirname(resolvedPath)

  while (true) {
    const candidate = packageJsonPathFor(current)
    if (fs.existsSync(candidate)) {
      const packageJson = readJson(candidate)
      if (!packageName || packageJson.name === packageName) {
        return candidate
      }
    }

    const parent = path.dirname(current)
    if (parent === current) {
      break
    }
    current = parent
  }

  throw new Error(
    `Unable to find package.json for ${packageName} from ${resolvedPath}`,
  )
}

function resolvePackageJson(packageName, fromPackageJson) {
  const requireFromPackage = createRequire(fromPackageJson)

  try {
    return requireFromPackage.resolve(`${packageName}/package.json`)
  } catch {
    for (const lookupPath of requireFromPackage.resolve.paths(packageName) ??
      []) {
      const candidate = path.join(
        lookupPath,
        ...packageName.split("/"),
        "package.json",
      )
      if (fs.existsSync(candidate)) {
        return candidate
      }
    }

    const resolvedEntrypoint = requireFromPackage.resolve(packageName)
    return findPackageJsonFromResolvedPath(resolvedEntrypoint, packageName)
  }
}

function getPackageRelativePath(packageDir, nodeModulesRoot) {
  const realPackageDir = fs.realpathSync(packageDir)
  const realNodeModulesRoot = fs.realpathSync(nodeModulesRoot)
  const relativePath = path.relative(realNodeModulesRoot, realPackageDir)
  if (
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath) ||
    relativePath.length === 0
  ) {
    throw new Error(
      `Package ${packageDir} is outside node_modules root ${nodeModulesRoot}`,
    )
  }
  return relativePath
}

function enqueueDependencies(queue, packageJson, packageJsonPath) {
  for (const packageName of Object.keys(packageJson.dependencies ?? {})) {
    queue.push({
      fromPackageJson: packageJsonPath,
      name: packageName,
      optional: false,
    })
  }

  for (const packageName of Object.keys(
    packageJson.optionalDependencies ?? {},
  )) {
    queue.push({
      fromPackageJson: packageJsonPath,
      name: packageName,
      optional: true,
    })
  }
}

export function collectInstalledPackageClosure({
  entryPackages,
  rootPackageJson,
  nodeModulesRoot,
}) {
  const packages = new Map()
  const skippedOptionalPackages = []
  const queue = entryPackages.map((packageName) => ({
    fromPackageJson: rootPackageJson,
    name: packageName,
    optional: false,
  }))

  while (queue.length > 0) {
    const current = queue.shift()
    let packageJsonPath

    try {
      packageJsonPath = resolvePackageJson(
        current.name,
        current.fromPackageJson,
      )
    } catch (error) {
      if (current.optional) {
        skippedOptionalPackages.push({
          name: current.name,
          reason: error.code ?? "resolve_failed",
        })
        continue
      }
      throw error
    }

    const packageDir = path.dirname(packageJsonPath)
    const packageJson = readJson(packageJsonPath)
    const packageName = packageJson.name ?? current.name
    const relativePath = getPackageRelativePath(packageDir, nodeModulesRoot)
    const key = `${packageName}\0${relativePath}`

    if (packages.has(key)) {
      continue
    }

    const packageInfo = {
      dir: packageDir,
      name: packageName,
      packageJsonPath,
      relativePath,
      version: packageJson.version ?? "unknown",
    }
    packages.set(key, packageInfo)

    enqueueDependencies(queue, packageJson, packageJsonPath)
  }

  return {
    packages: Array.from(packages.values()).sort((a, b) =>
      a.relativePath.localeCompare(b.relativePath),
    ),
    skippedOptionalPackages,
  }
}

export function copyPackageClosureToNodeModules(
  packages,
  destinationNodeModules,
) {
  fs.rmSync(destinationNodeModules, { force: true, recursive: true })
  fs.mkdirSync(destinationNodeModules, { recursive: true })

  for (const packageInfo of packages) {
    const destination = path.join(
      destinationNodeModules,
      packageInfo.relativePath,
    )
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.cpSync(packageInfo.dir, destination, {
      dereference: false,
      force: true,
      recursive: true,
    })
  }
}

export function writePackageClosureManifest({
  destination,
  entryPackages,
  packages,
  skippedOptionalPackages,
}) {
  fs.writeFileSync(
    destination,
    `${JSON.stringify(
      {
        entryPackages,
        generatedAt: new Date().toISOString(),
        packages: packages.map(({ name, relativePath, version }) => ({
          name,
          relativePath,
          version,
        })),
        skippedOptionalPackages,
      },
      null,
      2,
    )}\n`,
  )
}
