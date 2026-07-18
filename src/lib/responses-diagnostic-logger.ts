import { createHandlerLogger } from "./logger"

export const responsesDiagnosticsLogger = createHandlerLogger(
  "responses-diagnostics",
  { mirrorToConsole: process.env.COPILOT_API_TEST_MODE !== "1" },
)
