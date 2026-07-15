import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const testLogDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "copilot-api-test-logs-"),
)

process.env.COPILOT_API_LOG_DIR = testLogDirectory
process.env.COPILOT_API_CODEX_MODEL_CATALOG_PATH = path.join(
  testLogDirectory,
  "codex-model-catalog.json",
)
process.env.COPILOT_API_TEST_MODE = "1"
