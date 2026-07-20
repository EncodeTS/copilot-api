import { describe, expect, test } from 'bun:test'

import {
  getCopilotAccountType,
  getGitHubUser,
  loginWithGitHubToken,
  type DesktopGitHubManualLoginDependencies,
} from '../electron/auth'

describe('desktop GitHub manual login', () => {
  test('forwards request cancellation through the production validation adapters', async () => {
    const caller = new AbortController()
    const requestSignals: AbortSignal[] = []
    const userName = await getGitHubUser('manual-token', {
      fetch: (_input, init) => {
        if (init?.signal instanceof AbortSignal) {
          requestSignals.push(init.signal)
        }
        return Promise.resolve(Response.json({ login: 'octocat' }))
      },
      signal: caller.signal,
    })
    const accountType = await getCopilotAccountType('manual-token', {
      fetch: (_input, init) => {
        if (init?.signal instanceof AbortSignal) {
          requestSignals.push(init.signal)
        }
        return Promise.resolve(
          Response.json({
            copilot_plan: 'Copilot Business',
            endpoints: {
              api: 'https://api.example',
              telemetry: 'https://telemetry.example',
            },
            login: 'octocat',
            quota_snapshots: {},
          }),
        )
      },
      signal: caller.signal,
    })

    expect(userName).toBe('octocat')
    expect(accountType).toBe('business')
    expect(requestSignals).toHaveLength(2)
    expect(requestSignals.every((signal) => !signal.aborted)).toBe(true)
  })

  test('keeps account fallback but never swallows caller cancellation', async () => {
    await expect(
      getCopilotAccountType('manual-token-fallback', {
        fetch: () => Promise.resolve(new Response(null, { status: 503 })),
      }),
    ).resolves.toBe('individual')

    const controller = new AbortController()
    controller.abort()
    const error: unknown = await getCopilotAccountType('manual-token', {
      fetch: () => Promise.reject(new Error('must not dispatch')),
      signal: controller.signal,
    }).catch((caught: unknown) => caught)

    expect(error).toMatchObject({ kind: 'aborted' })
  })

  test('reserves the shared lifecycle before validation and commits with its session', async () => {
    const controller = new AbortController()
    const order: string[] = []
    const session = {
      credentialRevision: 'manual-reservation',
      lifecycleEpoch: 1,
      signal: controller.signal,
    }
    const dependencies: DesktopGitHubManualLoginDependencies = {
      beginLogin: () => {
        order.push('reserve')
        return Promise.resolve(session)
      },
      cancelLogin: () => {
        order.push('cancel')
      },
      getAccountType: (_token, options) => {
        expect(options?.signal).toBe(session.signal)
        order.push('account')
        return Promise.resolve('business')
      },
      getUser: (_token, options) => {
        expect(options?.signal).toBe(session.signal)
        order.push('user')
        return Promise.resolve('octocat')
      },
      persistToken: (receivedSession, token) => {
        expect(receivedSession).toBe(session)
        expect(token).toBe('manual-token')
        order.push('persist')
        return Promise.resolve()
      },
    }

    const result = await loginWithGitHubToken('manual-token', dependencies)

    expect(result).toEqual({ accountType: 'business', userName: 'octocat' })
    expect(order).toEqual(['reserve', 'user', 'account', 'persist'])
  })

  test('cancels the reserved session when validation fails', async () => {
    const controller = new AbortController()
    const session = {
      credentialRevision: 'manual-reservation',
      lifecycleEpoch: 1,
      signal: controller.signal,
    }
    let cancelledSession: typeof session | undefined
    let persisted = false
    const dependencies: DesktopGitHubManualLoginDependencies = {
      beginLogin: () => Promise.resolve(session),
      cancelLogin: (receivedSession) => {
        cancelledSession = receivedSession
      },
      getAccountType: () => Promise.resolve('individual'),
      getUser: () => Promise.reject(new Error('invalid token')),
      persistToken: () => {
        persisted = true
        return Promise.resolve()
      },
    }

    const error: unknown = await loginWithGitHubToken(
      'invalid-token',
      dependencies,
    ).catch((caught: unknown) => caught)

    expect(error).toMatchObject({ message: 'invalid token' })
    expect(cancelledSession).toBe(session)
    expect(persisted).toBe(false)
  })
})
