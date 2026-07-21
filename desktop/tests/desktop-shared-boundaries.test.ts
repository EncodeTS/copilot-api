import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url))
const probePath = fileURLToPath(
  new URL('./desktop-shared-boundaries.probe.ts', import.meta.url),
)

test('Desktop shared boundaries are hermetic across module-cache order', async () => {
  const child = Bun.spawn([process.execPath, 'test', probePath], {
    cwd: repositoryRoot,
    stderr: 'pipe',
    stdout: 'pipe',
  })
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ])

  expect(exitCode, `${stderr}\n${stdout}`).toBe(0)
  expect(`${stdout}\n${stderr}`).toContain('4 pass')
})
