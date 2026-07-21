import { describe, expect, test } from 'bun:test'

import { buildServerStartArgs } from '../electron/server-start-args'
import { buildServerLoopbackUrl } from '../electron/server-loopback'

describe('Desktop server network defaults', () => {
  test('keeps the packaged server on the secure loopback default', () => {
    expect(buildServerStartArgs(4510, 'github-token')).toEqual([
      'start',
      '--port',
      '4510',
      '--github-token',
      'github-token',
    ])
    expect(buildServerStartArgs(4510, 'github-token')).not.toContain('--lan')
  })

  test('uses an IPv4 literal for every internal server URL', async () => {
    const listener = Bun.serve({
      fetch: () => new Response('ready'),
      hostname: '127.0.0.1',
      port: 0,
    })

    try {
      if (listener.port === undefined) throw new Error('Listener has no port')
      const url = buildServerLoopbackUrl(listener.port, '/health?probe=desktop')
      expect(new URL(url).hostname).toBe('127.0.0.1')
      expect(url).not.toContain('localhost')
      expect(await (await fetch(url)).text()).toBe('ready')
    } finally {
      await listener.stop(true)
    }
  })
})
