import { app, utilityProcess } from 'electron'
import net from 'node:net'
import path from 'node:path'

import type {
  LogFeedBatch,
  LogFeedSnapshot,
  ServerStatus,
} from '../src/types/ipc'
import { tMain } from './i18n'
import {
  createServerManager,
  registerDefaultServerManager,
} from './server-manager'
import type { DesktopServerLaunchMode } from './server-start-args'
import { buildServerLoopbackUrl } from './server-loopback'

function checkPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => {
      server.close()
      resolve(true)
    })
    server.listen(port, '0.0.0.0')
  })
}

function getServerPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'server', 'main.js')
  }
  return path.join(app.getAppPath(), '..', 'dist', 'main.js')
}

async function probeServer(
  port: number,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    const response = await fetch(buildServerLoopbackUrl(port), {
      signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]),
    })
    return response.ok || response.status === 404
  } catch {
    return false
  }
}

const manager = createServerManager({
  fork: (modulePath, args, options) =>
    utilityProcess.fork(modulePath, args, options),
  getServerPath,
  isPortAvailable: checkPortAvailable,
  probeServer,
  translate: tMain,
})
registerDefaultServerManager(manager)

export const startServer = (
  port: number,
  launchMode: DesktopServerLaunchMode,
  options?: Parameters<typeof manager.start>[2],
): Promise<ServerStatus> => manager.start(port, launchMode, options)

export const stopServer = () => manager.stop()
export const reportServerError = (error: string): ServerStatus =>
  manager.reportError(error)
export const isRunning = (): boolean => manager.isRunning()
export const ownsProcess = (): boolean => manager.ownsProcess()
export const getStatus = (): ServerStatus => manager.getStatus()
export const getPort = (): number => manager.getPort()
export const onStatusChange = (
  callback: (status: ServerStatus) => void,
): void => manager.onStatusChange(callback)
export const clearCallbacks = (): void => manager.clearCallbacks()
export const getLogSnapshot = (): LogFeedSnapshot => manager.getLogSnapshot()
export const clearLogs = (): LogFeedSnapshot => manager.clearLogs()
export const subscribeLogs = (receive: (batch: LogFeedBatch) => void) =>
  manager.subscribeLogs(receive)
