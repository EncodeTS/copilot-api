export const LIVE_TEST_OPT_IN_ENV = "COPILOT_API_RUN_LIVE_TESTS"

export const isLiveTestEnabled = (
  env: Record<string, string | undefined> = process.env,
): boolean => env[LIVE_TEST_OPT_IN_ENV] === "1"
