import { randomUUID } from "node:crypto"
import fsSync from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"

export const PRIVATE_DIRECTORY_MODE = 0o700
export const PRIVATE_FILE_MODE = 0o600

export const supportsPosixPermissionModes = (
  platform: NodeJS.Platform = process.platform,
): boolean => platform !== "win32"

const isMissingFileError = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT"

const assertRegularStateFile = (
  filePath: string,
  stats: fsSync.Stats,
): void => {
  if (!stats.isFile()) {
    throw new Error(`Sensitive state path is not a regular file: ${filePath}`)
  }
}

export const ensurePrivateDirectory = async (
  directoryPath: string,
): Promise<void> => {
  await fs.mkdir(directoryPath, {
    mode: PRIVATE_DIRECTORY_MODE,
    recursive: true,
  })
  if (supportsPosixPermissionModes()) {
    await fs.chmod(directoryPath, PRIVATE_DIRECTORY_MODE)
  }
}

export const ensurePrivateDirectorySync = (directoryPath: string): void => {
  fsSync.mkdirSync(directoryPath, {
    mode: PRIVATE_DIRECTORY_MODE,
    recursive: true,
  })
  if (supportsPosixPermissionModes()) {
    fsSync.chmodSync(directoryPath, PRIVATE_DIRECTORY_MODE)
  }
}

export const repairPrivateFile = async (filePath: string): Promise<boolean> => {
  let stats: fsSync.Stats
  try {
    stats = await fs.lstat(filePath)
  } catch (error) {
    if (isMissingFileError(error)) return false
    throw error
  }
  assertRegularStateFile(filePath, stats)
  if (supportsPosixPermissionModes()) {
    await fs.chmod(filePath, PRIVATE_FILE_MODE)
  }
  return true
}

export const repairPrivateFileSync = (filePath: string): boolean => {
  let stats: fsSync.Stats
  try {
    stats = fsSync.lstatSync(filePath)
  } catch (error) {
    if (isMissingFileError(error)) return false
    throw error
  }
  assertRegularStateFile(filePath, stats)
  if (supportsPosixPermissionModes()) {
    fsSync.chmodSync(filePath, PRIVATE_FILE_MODE)
  }
  return true
}

const createTemporaryPath = (destinationPath: string): string =>
  path.join(
    path.dirname(destinationPath),
    `.${path.basename(destinationPath)}.${process.pid}.${randomUUID()}.tmp`,
  )

export const atomicWriteProtectedFile = async (
  destinationPath: string,
  content: string | Uint8Array,
): Promise<void> => {
  await ensurePrivateDirectory(path.dirname(destinationPath))
  const temporaryPath = createTemporaryPath(destinationPath)

  try {
    const handle = await fs.open(temporaryPath, "wx", PRIVATE_FILE_MODE)
    try {
      await handle.writeFile(content)
      await handle.sync()
    } finally {
      await handle.close()
    }
    if (supportsPosixPermissionModes()) {
      await fs.chmod(temporaryPath, PRIVATE_FILE_MODE)
    }
    await fs.rename(temporaryPath, destinationPath)
    await repairPrivateFile(destinationPath)
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => {})
  }
}

export const atomicWriteProtectedFileSync = (
  destinationPath: string,
  content: string | Uint8Array,
): void => {
  ensurePrivateDirectorySync(path.dirname(destinationPath))
  const temporaryPath = createTemporaryPath(destinationPath)
  let descriptor: number | undefined

  try {
    descriptor = fsSync.openSync(temporaryPath, "wx", PRIVATE_FILE_MODE)
    fsSync.writeFileSync(descriptor, content)
    fsSync.fsyncSync(descriptor)
    fsSync.closeSync(descriptor)
    descriptor = undefined
    if (supportsPosixPermissionModes()) {
      fsSync.chmodSync(temporaryPath, PRIVATE_FILE_MODE)
    }
    fsSync.renameSync(temporaryPath, destinationPath)
    repairPrivateFileSync(destinationPath)
  } finally {
    if (descriptor !== undefined) fsSync.closeSync(descriptor)
    fsSync.rmSync(temporaryPath, { force: true })
  }
}

export const repairSqliteFilePermissions = async (
  databasePath: string,
): Promise<void> => {
  if (databasePath === ":memory:") return
  await repairPrivateFile(databasePath)
  await repairPrivateFile(`${databasePath}-wal`)
  await repairPrivateFile(`${databasePath}-shm`)
}
