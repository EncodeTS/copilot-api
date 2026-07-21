import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

const desktopRoot = fileURLToPath(new URL('..', import.meta.url))
const probePath = fileURLToPath(
  new URL('./desktop-shared-boundaries.probe.ts', import.meta.url),
)

async function runProbe(extraArguments: string[] = []): Promise<string> {
  const child = Bun.spawn(
    [process.execPath, 'test', probePath, ...extraArguments],
    {
      cwd: desktopRoot,
      stderr: 'pipe',
      stdout: 'pipe',
    },
  )
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ])
  expect(exitCode, `${stderr}\n${stdout}`).toBe(0)
  return `${stdout}\n${stderr}`
}

test('Desktop shared boundaries are hermetic across module-cache order', async () => {
  const outputs = await Promise.all([
    runProbe(),
    runProbe(['--randomize', '--seed', '101']),
    runProbe(['--randomize', '--seed', '424242']),
  ])

  for (const output of outputs) expect(output).toContain('14 pass')
})
