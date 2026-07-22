import { describe, expect, test } from 'bun:test'

import { buildServerLoopbackUrl } from '../electron/server-loopback'
import {
  buildServerEnvironment,
  buildServerStartArgs,
  resolveDesktopServerStart,
} from '../electron/server-start-args'

describe('Desktop server start policy', () => {
  test('passes only an explicit Copilot mode and never the credential value', () => {
    const secret = 'github-secret-sentinel'
    const args = buildServerStartArgs(4510, 'copilot')
    const env = buildServerEnvironment({
      ANTHROPIC_API_KEY: 'provider-key-remains-available',
      COPILOT_API_HOME: '/tmp/copilot-home',
      GH_TOKEN: secret,
      GITHUB_TOKEN: secret,
      NODE_ENV: 'development',
    })

    expect(args).toEqual([
      'start',
      '--port',
      '4510',
      '--desktop-auth-mode',
      'copilot',
    ])
    expect(args).not.toContain('--lan')
    expect(JSON.stringify({ args, env })).not.toContain(secret)
    expect(env).toMatchObject({
      ANTHROPIC_API_KEY: 'provider-key-remains-available',
      COPILOT_API_HOME: '/tmp/copilot-home',
      NODE_ENV: 'production',
    })
    expect(env.GH_TOKEN).toBeUndefined()
    expect(env.GITHUB_TOKEN).toBeUndefined()
  })

  test('filters GitHub credential environment keys case-insensitively on Windows', () => {
    const secret = 'mixed-case-secret'
    const env = buildServerEnvironment({
      Github_Token: secret,
      gh_token: secret,
      Gh_Enterprise_Token: secret,
      Github_Copilot_Token: secret,
      Github_Enterprise_Token: secret,
      copilot_Github_token: secret,
      SAFE_TOKEN_BUDGET: '2000',
    })

    expect(JSON.stringify(env)).not.toContain(secret)
    expect(env.SAFE_TOKEN_BUDGET).toBe('2000')
  })

  test('uses provider-only mode even when a GitHub credential also exists', () => {
    expect(
      resolveDesktopServerStart({
        authMode: 'provider',
        enabledProviderCount: 1,
        hasGitHubCredential: true,
      }),
    ).toEqual({ launchMode: 'provider', ok: true })
    expect(buildServerStartArgs(4510, 'provider')).toContain('provider')
  })

  test('fails closed when the selected credential kind is missing', () => {
    expect(
      resolveDesktopServerStart({
        authMode: 'copilot',
        enabledProviderCount: 1,
        hasGitHubCredential: false,
      }),
    ).toEqual({ ok: false, reason: 'auth_required' })
    expect(
      resolveDesktopServerStart({
        authMode: 'provider',
        enabledProviderCount: 0,
        hasGitHubCredential: true,
      }),
    ).toEqual({ ok: false, reason: 'auth_required' })
    expect(
      resolveDesktopServerStart({
        authMode: 'none',
        enabledProviderCount: 0,
        hasGitHubCredential: false,
      }),
    ).toEqual({ ok: false, reason: 'auth_required' })
  })

  test('resolves an unspecified mode without silently overriding an explicit mode', () => {
    expect(
      resolveDesktopServerStart({
        authMode: 'none',
        enabledProviderCount: 1,
        hasGitHubCredential: true,
      }),
    ).toEqual({ launchMode: 'copilot', ok: true })
    expect(
      resolveDesktopServerStart({
        authMode: undefined,
        enabledProviderCount: 1,
        hasGitHubCredential: false,
      }),
    ).toEqual({ launchMode: 'provider', ok: true })
  })

  test('uses an explicit IPv4 loopback URL without opening a real listener', () => {
    const url = buildServerLoopbackUrl(4510, '/health?probe=desktop')

    expect(url).toBe('http://127.0.0.1:4510/health?probe=desktop')
    expect(new URL(url).hostname).toBe('127.0.0.1')
    expect(url).not.toContain('localhost')
  })
})
