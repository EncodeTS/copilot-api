import {
  applyHermeticTestEnvironment,
  createHermeticTestPaths,
} from '../../tests/fixtures/hermetic-paths'

// Desktop can be tested as its own Bun project. Apply the same isolation before
// any Desktop or root product module captures persistent paths.
applyHermeticTestEnvironment(
  createHermeticTestPaths('copilot-api-desktop-test-'),
)
