import { expect, test } from 'bun:test'
import os from 'node:os'
import path from 'node:path'

import { PATHS } from '../../src/lib/paths'
import {
  getHermeticTestPaths,
  isInsideHermeticRoot,
} from '../../tests/fixtures/hermetic-paths'

test('Desktop Bun tests capture only an isolated application home', () => {
  const paths = getHermeticTestPaths()

  expect(path.resolve(paths.root)).toStartWith(path.resolve(os.tmpdir()))
  expect(isInsideHermeticRoot(paths.root, paths.appHome)).toBe(true)
  expect(process.env.COPILOT_API_TEST_MODE).toBe('1')
  expect(PATHS.APP_DIR).toBe(paths.appHome)
  expect(PATHS.CONFIG_PATH).toBe(paths.config)
  expect(PATHS.GITHUB_TOKEN_PATH).toBe(paths.githubToken)
})
