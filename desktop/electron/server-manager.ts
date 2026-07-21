import { utilityProcess, app } from 'electron'
import type { UtilityProcess } from 'electron'
import net from 'node:net'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'

import type { DesktopProxySettings, ServerStatus } from '../src/types/ipc'
import { applyDesktopProxySettingsToEnv } from './electron-proxy-config'
import { tMain } from './i18n'
import type {
  ResolvedServerCredentials,
  ServerCredentialMode,
} from './server-credentials'
import { buildServerStartArgs } from './server-start-args'
import { buildServerLoopbackUrl } from './server-loopback'

let serverProcess: UtilityProcess | null = null
let currentPort = 4141
let statusCallback: ((status: ServerStatus) => void) | null = null
let logCallback: ((log: string) => void) | null = null
let lastRestartContext: ServerRestartContext | null = null
let restartContextNonce = 0
// Ring buffer for logs, capped at 2000 entries for log panel replay.
const LOG_BUFFER_MAX = 2000
const STOP_TIMEOUT_MS = 5000
const logBuffer: string[] = []
const ESC_CHAR_CODE = 27
const BEL_CHAR_CODE = 7
const CSI_CHAR_CODE = 0x9b

interface ServerStartOptions {
  proxy?: DesktopProxySettings
  showToken?: boolean
  verbose?: boolean
}

export interface ServerCredentialContext {
  generation: number
  mode: ServerCredentialMode
}

interface ServerRestartContext {
  credentialGeneration: number
  credentialMode: ServerCredentialMode
  options: ServerStartOptions
  port: number
  nonce: number
}

interface PreparedServerCredentials {
  context: ServerCredentialContext
  token: string | null
}

interface ServerRestartGuard {
  invalidateContext: () => void
  isContextCurrent: () => boolean
  prepareForFork: () => Promise<PreparedServerCredentials | null>
  validateBeforeCommit: () => Promise<boolean>
}

const cloneProxySettings = (
  proxy: DesktopProxySettings | undefined,
): DesktopProxySettings | undefined => (proxy ? { ...proxy } : undefined)

const commitRestartContext = (
  port: number,
  options: ServerStartOptions,
  credentials: ServerCredentialContext | undefined,
): void => {
  restartContextNonce += 1
  lastRestartContext =
    credentials ?
      {
        credentialGeneration: credentials.generation,
        credentialMode: credentials.mode,
        nonce: restartContextNonce,
        options: {
          ...options,
          proxy: cloneProxySettings(options.proxy),
        },
        port,
      }
    : null
}

const restartContextMatches = (snapshot: ServerRestartContext): boolean =>
  lastRestartContext?.nonce === snapshot.nonce
  && lastRestartContext.credentialGeneration === snapshot.credentialGeneration

function codeAt(input: string, index: number): number {
  return input.codePointAt(index) ?? -1
}

function skipCsiSequence(input: string, startIndex: number): number {
  const inputLength = input.length
  let index = startIndex

  while (index < inputLength) {
    const code = codeAt(input, index)
    if (code >= 0x40 && code <= 0x7e) return index + 1
    index += 1
  }

  return inputLength
}

function skipStringTerminatedSequence(
  input: string,
  startIndex: number,
): number {
  const inputLength = input.length
  let index = startIndex

  while (index < inputLength) {
    const code = codeAt(input, index)

    if (code === BEL_CHAR_CODE) return index + 1
    if (code === ESC_CHAR_CODE && codeAt(input, index + 1) === 92) {
      return Math.min(index + 2, inputLength)
    }

    index += 1
  }

  return inputLength
}

function stripAnsi(input: string): string {
  const inputLength = input.length
  let lastIndex = 0
  let index = 0
  let stripped = false
  const parts: Array<string> = []

  while (index < inputLength) {
    const code = codeAt(input, index)
    if (code !== ESC_CHAR_CODE && code !== CSI_CHAR_CODE) {
      index += 1
      continue
    }

    stripped = true
    if (index > lastIndex) parts.push(input.slice(lastIndex, index))

    if (code === CSI_CHAR_CODE) {
      index = skipCsiSequence(input, index + 1)
      lastIndex = index
      continue
    }

    const next = input[index + 1]
    if (next === '[') {
      index = skipCsiSequence(input, index + 2)
      lastIndex = index
      continue
    }

    if (
      next === ']'
      || next === 'P'
      || next === 'X'
      || next === '^'
      || next === '_'
    ) {
      index = skipStringTerminatedSequence(input, index + 2)
      lastIndex = index
      continue
    }

    index = Math.min(index + 2, inputLength)
    lastIndex = index
  }

  if (!stripped) return input
  if (lastIndex < inputLength) parts.push(input.slice(lastIndex))
  return parts.join('')
}

function emitLog(message: string): void {
  const sanitizedMessage = stripAnsi(message)
  if (sanitizedMessage.length === 0) return

  logBuffer.push(sanitizedMessage)
  if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift()
  logCallback?.(sanitizedMessage)
}

function createLogStream() {
  const decoder = new StringDecoder('utf8')
  let flushed = false

  return {
    handleData: (data: Buffer) => {
      emitLog(decoder.write(data))
    },
    flush: () => {
      if (flushed) return
      flushed = true
      emitLog(decoder.end())
    },
  }
}

export function onStatusChange(cb: (status: ServerStatus) => void): void {
  statusCallback = cb
}

export function onLog(cb: (log: string) => void): void {
  logCallback = cb
}

function checkPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => {
      server.close()
      resolve(true)
    })
    // Bind to 0.0.0.0 to check whether the port is occupied on any interface.
    server.listen(port, '0.0.0.0')
  })
}

function getServerPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'server', 'main.js')
  }
  // In development, use dist/main.js from the project root.
  return path.join(app.getAppPath(), '..', 'dist', 'main.js')
}

export function getServerReadinessUrl(port: number): string {
  return buildServerLoopbackUrl(port)
}

export async function startServer(
  port: number,
  token: string | null,
  serverOptions: ServerStartOptions = {},
  credentialContext?: ServerCredentialContext,
  restartGuard?: ServerRestartGuard,
): Promise<ServerStatus> {
  const available = await checkPortAvailable(port)
  if (!available) {
    return {
      running: false,
      error: await tMain('server.portInUse', { port }),
    }
  }

  if (serverProcess) {
    await stopServer()
  }

  currentPort = port

  // Clear the previous log buffer before each new server start.
  logBuffer.length = 0

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'production',
  }
  let proxyEnabled: boolean
  try {
    proxyEnabled =
      serverOptions.proxy ?
        applyDesktopProxySettingsToEnv(env, serverOptions.proxy)
      : false
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : 'Invalid proxy settings',
      running: false,
    }
  }

  let effectiveToken = token
  let effectiveCredentialContext = credentialContext
  if (restartGuard) {
    const preparedCredentials = await restartGuard.prepareForFork()
    if (!preparedCredentials || !restartGuard.isContextCurrent()) {
      return {
        error: 'Credential state changed before utility server restart',
        running: false,
      }
    }
    effectiveToken = preparedCredentials.token
    effectiveCredentialContext = preparedCredentials.context
  }

  const serverPath = getServerPath()
  const args = buildServerStartArgs(port, effectiveToken)
  if (proxyEnabled) args.push('--proxy-env')
  if (serverOptions.verbose) args.push('--verbose')
  if (serverOptions.showToken) args.push('--show-token')

  // utilityProcess.fork is an official Electron API and does not start another
  // Electron instance, so packaged macOS builds do not show a second Dock icon.
  let proc: UtilityProcess
  try {
    proc = utilityProcess.fork(serverPath, args, {
      env,
      stdio: 'pipe',
      serviceName: 'copilot-api-server',
    })
  } catch (error) {
    return {
      error:
        error instanceof Error ?
          error.message
        : 'Failed to start utility server',
      running: false,
    }
  }
  serverProcess = proc

  // Decode streamed UTF-8 safely so chunk boundaries do not corrupt Chinese or box-drawing characters.
  const stdoutLogStream = createLogStream()
  const stderrLogStream = createLogStream()

  proc.stdout?.on('data', stdoutLogStream.handleData)
  proc.stdout?.once('end', stdoutLogStream.flush)
  proc.stdout?.once('close', stdoutLogStream.flush)
  proc.stderr?.on('data', stderrLogStream.handleData)
  proc.stderr?.once('end', stderrLogStream.flush)
  proc.stderr?.once('close', stderrLogStream.flush)

  // Wait for the server to become ready while also detecting early process exit.
  const startResult = await waitForServer(port, proc)
  if (!startResult.ok) {
    proc.kill()
    if (serverProcess === proc) {
      serverProcess = null
    }
    const msg =
      startResult.exitCode !== undefined ?
        await tMain('server.startFailed', { code: startResult.exitCode })
      : await tMain('server.startTimeout', { port })
    return { running: false, error: msg }
  }

  if (restartGuard) {
    let credentialsStillCurrent = false
    try {
      credentialsStillCurrent = await restartGuard.validateBeforeCommit()
    } catch {
      credentialsStillCurrent = false
    }
    if (!credentialsStillCurrent || !restartGuard.isContextCurrent()) {
      restartGuard.invalidateContext()
      if (serverProcess === proc) await stopServer()
      return {
        error: 'Credential state changed while utility server was starting',
        running: false,
      }
    }
  }

  // Register the runtime exit handler only after startup succeeds.
  proc.on('exit', (code) => {
    stdoutLogStream.flush()
    stderrLogStream.flush()
    if (serverProcess !== proc) return

    serverProcess = null

    if (code === 0) {
      statusCallback?.({ running: false })
      return
    }

    void tMain('server.processExit', { code: String(code ?? 'unknown') }).then(
      (error) => {
        statusCallback?.({
          running: false,
          error,
        })
      },
    )
  })

  commitRestartContext(port, serverOptions, effectiveCredentialContext)
  return { running: true, port }
}

// Wait for server readiness or process exit, whichever happens first.
async function waitForServer(
  port: number,
  proc: UtilityProcess,
): Promise<{ ok: boolean; exitCode?: number }> {
  return new Promise((resolve) => {
    let settled = false

    const finish = (result: { ok: boolean; exitCode?: number }) => {
      if (settled) return
      settled = true
      proc.removeListener('exit', onExit)
      resolve(result)
    }

    const onExit = (code: number) => {
      finish({ ok: false, exitCode: code ?? undefined })
    }

    proc.once('exit', onExit)

    ;(async () => {
      const url = getServerReadinessUrl(port)
      for (let i = 0; i < 20; i++) {
        await new Promise<void>((r) => setTimeout(r, 500))
        if (settled) return
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(1000) })
          if (res.ok || res.status === 404) {
            finish({ ok: true })
            return
          }
        } catch {
          // Keep waiting.
        }
      }
      finish({ ok: false }) // Timed out.
    })().catch(() => finish({ ok: false }))
  })
}

function waitForProcessExit(
  proc: UtilityProcess,
  options: { kill: boolean; timeoutMs: number },
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false

    const finish = (exited: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      proc.removeListener('exit', onExit)
      resolve(exited)
    }

    const onExit = () => finish(true)
    const timeout = setTimeout(
      () => finish(proc.pid === undefined),
      options.timeoutMs,
    )

    proc.once('exit', onExit)
    if (options.kill && !proc.kill()) finish(proc.pid === undefined)
  })
}

export async function stopServer(): Promise<void> {
  if (!serverProcess) return
  const proc = serverProcess
  let exited = await waitForProcessExit(proc, {
    kill: true,
    timeoutMs: STOP_TIMEOUT_MS,
  })

  if (!exited && proc.pid !== undefined) {
    try {
      process.kill(proc.pid, 'SIGKILL')
    } catch (error) {
      if (!(
        error instanceof Error
        && 'code' in error
        && error.code === 'ESRCH'
      )) {
        throw error
      }
    }
    exited = await waitForProcessExit(proc, { kill: false, timeoutMs: 1_000 })
  }

  if (!exited && proc.pid !== undefined) {
    // Continuing the Desktop app would leave the old network policy active.
    // Exiting also terminates the utility process and is the final fail-closed
    // boundary when both graceful and forced termination could not be proven.
    app.exit(1)
    throw new Error('Utility server did not stop safely')
  }

  if (serverProcess === proc) {
    serverProcess = null
    statusCallback?.({ running: false })
  }
}

export async function restartServerWithProxy(
  proxy: DesktopProxySettings,
  resolveCredentials: (
    preferredMode: ServerCredentialMode,
  ) => Promise<ResolvedServerCredentials | null>,
): Promise<ServerStatus> {
  if (serverProcess) {
    return {
      error: 'Utility server must be stopped before applying a proxy restart',
      running: false,
    }
  }
  if (!lastRestartContext) {
    return {
      error: 'No safe utility server restart context is available',
      running: false,
    }
  }

  const contextSnapshot = { ...lastRestartContext }
  const credentials = await resolveCredentials(contextSnapshot.credentialMode)
  if (!restartContextMatches(contextSnapshot)) {
    return {
      error: 'Utility server restart context was invalidated',
      running: false,
    }
  }
  if (!credentials) {
    clearServerRestartContext()
    return {
      error:
        'Current credentials are unavailable; utility server remains stopped',
      running: false,
    }
  }

  const status = await startServer(
    contextSnapshot.port,
    credentials.token,
    {
      ...contextSnapshot.options,
      proxy: cloneProxySettings(proxy),
    },
    { generation: credentials.generation, mode: credentials.mode },
    {
      invalidateContext: clearServerRestartContext,
      isContextCurrent: () => restartContextMatches(contextSnapshot),
      prepareForFork: async () => {
        const currentCredentials = await resolveCredentials(
          contextSnapshot.credentialMode,
        )
        if (
          !currentCredentials
          || currentCredentials.generation !== credentials.generation
          || currentCredentials.mode !== credentials.mode
          || !restartContextMatches(contextSnapshot)
        ) {
          return null
        }
        return {
          context: {
            generation: currentCredentials.generation,
            mode: currentCredentials.mode,
          },
          token: currentCredentials.token,
        }
      },
      validateBeforeCommit: async () => {
        const currentCredentials = await resolveCredentials(
          contextSnapshot.credentialMode,
        )
        return Boolean(
          currentCredentials
          && currentCredentials.generation === credentials.generation
          && currentCredentials.mode === credentials.mode
          && restartContextMatches(contextSnapshot),
        )
      },
    },
  )
  statusCallback?.(status)
  return status
}

export function clearServerRestartContext(): void {
  restartContextNonce += 1
  lastRestartContext = null
}

export function getServerRestartContextDiagnostics(): {
  generation: number
  mode: ServerCredentialMode
  port: number
} | null {
  return lastRestartContext ?
      {
        generation: lastRestartContext.credentialGeneration,
        mode: lastRestartContext.credentialMode,
        port: lastRestartContext.port,
      }
    : null
}

export function isRunning(): boolean {
  return serverProcess !== null
}

export function clearCallbacks(): void {
  statusCallback = null
  logCallback = null
}

export function getPort(): number {
  return currentPort
}

export function getLogs(): string[] {
  return [...logBuffer]
}
