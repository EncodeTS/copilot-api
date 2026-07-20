import {
  applyHermeticTestEnvironment,
  createHermeticTestPaths,
} from "./fixtures/hermetic-paths"

// Bun loads this file before test modules. Override every persistent path here
// so product modules can never capture a caller's real application home.
applyHermeticTestEnvironment(createHermeticTestPaths())
