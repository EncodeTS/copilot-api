import { expect, test } from 'bun:test'

import { createServerCredentialResolver } from '../electron/server-credentials'
import { logoutDesktopServerSession } from '../electron/server-logout'

test('external token rotation advances generation and returns only the new token', async () => {
  let token: string | null = 'old-token'
  const resolver = createServerCredentialResolver({
    listEnabledProviders: () => [],
    readToken: () => Promise.resolve(token),
  })

  const first = await resolver.resolve('copilot')
  token = 'new-token'
  const rotated = await resolver.resolve('copilot')

  expect(first).toEqual({
    generation: 1,
    mode: 'copilot',
    token: 'old-token',
  })
  expect(rotated).toEqual({
    generation: 2,
    mode: 'copilot',
    token: 'new-token',
  })
})

test('provider preference never returns a GitHub token', async () => {
  const resolver = createServerCredentialResolver({
    listEnabledProviders: () => ['custom-provider'],
    readToken: () => Promise.resolve('saved-token'),
  })

  expect(await resolver.resolve('provider')).toEqual({
    generation: 1,
    mode: 'provider',
    token: null,
  })
})

test('explicit provider mode does not fall back to a saved GitHub token', async () => {
  const resolver = createServerCredentialResolver({
    listEnabledProviders: () => [],
    readToken: () => Promise.resolve('saved-token'),
  })

  expect(await resolver.resolve('provider', false)).toBeNull()
})

test('credential mutation invalidates generation and current availability chooses mode', async () => {
  let token: string | null = null
  let providers = ['custom-provider']
  const resolver = createServerCredentialResolver({
    listEnabledProviders: () => providers,
    readToken: () => Promise.resolve(token),
  })

  expect(await resolver.resolve('copilot')).toMatchObject({
    generation: 1,
    mode: 'provider',
    token: null,
  })

  token = 'manual-token'
  providers = []
  resolver.markChanged()
  expect(await resolver.resolve('provider')).toEqual({
    generation: 2,
    mode: 'copilot',
    token: 'manual-token',
  })

  token = null
  resolver.markChanged()
  expect(await resolver.resolve('copilot')).toBeNull()
  expect(resolver.getGeneration()).toBe(3)
})

test('logout clears restart context before stopping and invalidates credentials', async () => {
  const events: string[] = []

  await logoutDesktopServerSession({
    clearRestartContext: () => events.push('clear-context'),
    clearToken: () => {
      events.push('clear-token')
      return Promise.resolve()
    },
    markCredentialsChanged: () => events.push('mark-generation'),
    stopServer: () => {
      events.push('stop-server')
      return Promise.resolve()
    },
  })

  expect(events).toEqual([
    'clear-context',
    'stop-server',
    'clear-token',
    'mark-generation',
  ])
})

test('logout does not report a new generation when token clearing fails', async () => {
  const events: string[] = []
  let rejection: unknown
  try {
    await logoutDesktopServerSession({
      clearRestartContext: () => events.push('clear-context'),
      clearToken: () => Promise.reject(new Error('token clear failed')),
      markCredentialsChanged: () => events.push('mark-generation'),
      stopServer: () => {
        events.push('stop-server')
        return Promise.resolve()
      },
    })
  } catch (error) {
    rejection = error
  }

  expect(rejection).toBeInstanceOf(Error)
  expect(events).toEqual(['clear-context', 'stop-server'])
})
