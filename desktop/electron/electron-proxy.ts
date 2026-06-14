import { app, session } from 'electron'

import { resolveElectronProxyConfigFromEnv } from './electron-proxy-config'

export function applyElectronProxyCommandLineFromEnv(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const proxyConfig = resolveElectronProxyConfigFromEnv(env)
  if (!proxyConfig) return false

  app.commandLine.appendSwitch('proxy-server', proxyConfig.proxyRules)
  if (proxyConfig.proxyBypassRules) {
    app.commandLine.appendSwitch('proxy-bypass-list', proxyConfig.proxyBypassRules)
  }

  console.info(`Electron command-line proxy configured from environment: ${proxyConfig.proxyRules}`)
  return true
}

export async function applyElectronProxyFromEnv(
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const proxyConfig = resolveElectronProxyConfigFromEnv(env)
  if (!proxyConfig) return

  try {
    await app.setProxy(proxyConfig)
    await session.defaultSession.setProxy(proxyConfig)
    await session.defaultSession.closeAllConnections()
    await session.defaultSession.forceReloadProxyConfig()
    console.info(`Electron proxy configured from environment: ${proxyConfig.proxyRules}`)
  } catch (error) {
    console.warn('Failed to configure Electron proxy from environment.', error)
  }
}
