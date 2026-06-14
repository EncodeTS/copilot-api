const PROXY_ENV_KEYS = {
  all: ['ALL_PROXY', 'all_proxy'],
  http: ['HTTP_PROXY', 'http_proxy'],
  https: ['HTTPS_PROXY', 'https_proxy'],
  noProxy: ['NO_PROXY', 'no_proxy']
} as const

const DEFAULT_PROXY_BYPASS_RULES = ['<local>', 'localhost', '127.0.0.1', '[::1]']

export interface ElectronProxyConfig {
  mode: 'fixed_servers'
  proxyBypassRules?: string
  proxyRules: string
}

function readEnvValue(env: NodeJS.ProcessEnv, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = env[key]?.trim()
    if (value) return value
  }

  return null
}

function createProxyUrl(rawProxy: string): URL | null {
  const value = rawProxy.trim()
  if (!value) return null

  try {
    return new URL(value.includes('://') ? value : `http://${value}`)
  } catch {
    return null
  }
}

function formatProxyHost(url: URL): string | null {
  if (!url.hostname) return null

  const hostname = url.hostname.includes(':') ? `[${url.hostname.replace(/^\[|\]$/g, '')}]` : url.hostname
  return `${hostname}${url.port ? `:${url.port}` : ''}`
}

function formatProxyServer(rawProxy: string): string | null {
  const url = createProxyUrl(rawProxy)
  if (!url) return null

  const host = formatProxyHost(url)
  if (!host) return null

  switch (url.protocol) {
    case 'http:':
      return host
    case 'https:':
      return `https://${host}`
    case 'socks:':
    case 'socks4:':
    case 'socks5:':
      return `${url.protocol}//${host}`
    default:
      return null
  }
}

function normalizeNoProxyRule(rule: string): string | null {
  const trimmed = rule.trim()
  if (!trimmed) return null
  if (trimmed === '*') return trimmed
  if (trimmed.startsWith('.')) return `*${trimmed}`
  return trimmed
}

function buildProxyBypassRules(noProxy: string | null): string {
  const rules = [...DEFAULT_PROXY_BYPASS_RULES]

  if (noProxy) {
    for (const rawRule of noProxy.split(',')) {
      const rule = normalizeNoProxyRule(rawRule)
      if (rule && !rules.includes(rule)) {
        rules.push(rule)
      }
    }
  }

  return rules.join(';')
}

export function resolveElectronProxyConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): ElectronProxyConfig | null {
  const allProxy = readEnvValue(env, PROXY_ENV_KEYS.all)
  const httpProxy = readEnvValue(env, PROXY_ENV_KEYS.http) ?? allProxy
  const httpsProxy = readEnvValue(env, PROXY_ENV_KEYS.https) ?? allProxy

  const httpProxyServer = httpProxy ? formatProxyServer(httpProxy) : null
  const httpsProxyServer = httpsProxy ? formatProxyServer(httpsProxy) : null
  if (!httpProxyServer && !httpsProxyServer) return null

  const proxyRules = [
    httpProxyServer ? `http=${httpProxyServer}` : null,
    httpsProxyServer ? `https=${httpsProxyServer}` : null
  ].filter((rule): rule is string => rule !== null)

  return {
    mode: 'fixed_servers',
    proxyBypassRules: buildProxyBypassRules(readEnvValue(env, PROXY_ENV_KEYS.noProxy)),
    proxyRules: proxyRules.join(';')
  }
}
