import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

interface ConfigFileShape {
  auth?: {
    adminApiKey?: string
    apiKeys?: Array<string>
  }
  builtinProviders?: Record<string, unknown>
  configSchemaVersion?: number
  contextManagement?: {
    messages?: boolean
    responses?: boolean
  }
  extraPrompts?: Record<string, string>
  futureSetting?: {
    enabled?: boolean
  }
  modelReasoningEfforts?: Record<string, string>
  modelResponsesApiCompactThresholds?: Record<string, number>
  migrationState?: {
    contextManagementMessages?: string
  }
  responsesImageCompression?: boolean
  responsesImageCompressionCacheBytes?: number
  responsesImageCompressionConcurrency?: number
  responsesImageCompressionMaxActionsPerRequest?: number
  responsesImageMaxInputImageBytes?: number
  responsesImageOptimization?: boolean
  responsesImageRetryRequiresHttp?: boolean
  responsesPayloadBudgetBytes?: number
  responsesPayloadRetryBudgetBytes?: number
  responsesPayloadSendHardLimitBytes?: number
  responsesApiContextManagementModels?: Array<string>
  useFunctionApplyPatch?: boolean
  useResponsesApiWebSocket?: boolean
  providers?: Record<
    string,
    {
      type?: string
      enabled?: boolean
      baseUrl?: string
      apiKey?: string
      authType?: string
      capabilities?: {
        responsesContextManagement?: boolean
      }
    }
  >
}

const cwd = fileURLToPath(new URL("../", import.meta.url))
const decoder = new TextDecoder()
const tempDirs: Array<string> = []

function createTempConfigDir(): string {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "copilot-api-builtin-provider-"),
  )
  tempDirs.push(tempDir)
  return tempDir
}

function writeConfigFile(tempDir: string, config: ConfigFileShape): string {
  const configPath = path.join(tempDir, "config.json")
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8")
  return configPath
}

function readConfigFile(configPath: string): ConfigFileShape {
  return JSON.parse(fs.readFileSync(configPath, "utf8")) as ConfigFileShape
}

function runScriptWithOutput(
  tempDir: string,
  script: string,
): { stderr: string; stdout: string } {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "--eval", script],
    cwd,
    env: {
      ...process.env,
      COPILOT_API_HOME: tempDir,
      COPILOT_API_OAUTH_APP: "",
      COPILOT_API_ENTERPRISE_URL: "",
    },
  })

  if (result.exitCode !== 0) {
    throw new Error(
      `Script failed with exit code ${result.exitCode}\nstdout:\n${decoder.decode(result.stdout)}\nstderr:\n${decoder.decode(result.stderr)}`,
    )
  }

  return {
    stderr: decoder.decode(result.stderr).trim(),
    stdout: decoder.decode(result.stdout).trim(),
  }
}

function runScript(tempDir: string, script: string): string {
  return runScriptWithOutput(tempDir, script).stdout
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop()
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

describe("builtin provider config", () => {
  test("persists credentials and overrides without materializing defaults", () => {
    const tempDir = createTempConfigDir()
    const configPath = path.join(tempDir, "config.json")

    runScript(
      tempDir,
      'const { mergeConfigWithDefaults } = await import("./src/lib/config"); mergeConfigWithDefaults();',
    )

    const persisted = readConfigFile(configPath)
    expect(persisted.configSchemaVersion).toBe(2)
    expect(persisted.auth?.adminApiKey).toMatch(/^[a-f0-9]{64}$/)
    expect(persisted.auth?.apiKeys).toBeUndefined()
    expect(persisted.contextManagement).toBeUndefined()
    expect(persisted.extraPrompts).toBeUndefined()
    expect(persisted.modelReasoningEfforts).toBeUndefined()
    expect(persisted.responsesImageOptimization).toBeUndefined()
    expect(persisted.responsesPayloadBudgetBytes).toBeUndefined()
    expect(persisted.useResponsesApiWebSocket).toBeUndefined()
  })

  test("prunes materialized defaults while preserving overrides and unknown fields", () => {
    const tempDir = createTempConfigDir()
    const configPath = writeConfigFile(tempDir, {
      futureSetting: { enabled: true },
      responsesImageOptimization: true,
      responsesPayloadBudgetBytes: 31_457_280,
      useResponsesApiWebSocket: false,
    })

    runScript(
      tempDir,
      'const { mergeConfigWithDefaults } = await import("./src/lib/config"); mergeConfigWithDefaults();',
    )

    const persisted = readConfigFile(configPath)
    expect(persisted.futureSetting).toEqual({ enabled: true })
    expect(persisted.useResponsesApiWebSocket).toBe(false)
    expect(persisted.responsesImageOptimization).toBeUndefined()
    expect(persisted.responsesPayloadBudgetBytes).toBeUndefined()
  })

  test("preserves explicit values after sparse config migration", () => {
    const tempDir = createTempConfigDir()
    const configPath = writeConfigFile(tempDir, {
      configSchemaVersion: 2,
      contextManagement: {
        responses: false,
      },
    })

    runScript(
      tempDir,
      'const { mergeConfigWithDefaults } = await import("./src/lib/config"); mergeConfigWithDefaults();',
    )

    expect(readConfigFile(configPath).contextManagement).toEqual({
      responses: false,
    })
  })

  test("does not persist builtinProviders when missing", () => {
    const tempDir = createTempConfigDir()
    const configPath = writeConfigFile(tempDir, {})

    runScript(
      tempDir,
      'const { mergeConfigWithDefaults } = await import("./src/lib/config"); mergeConfigWithDefaults();',
    )

    expect(readConfigFile(configPath).builtinProviders).toBeUndefined()
  })

  test("uses context management defaults by endpoint", () => {
    const tempDir = createTempConfigDir()
    const configPath = path.join(tempDir, "config.json")

    const output = runScript(
      tempDir,
      'const { isContextManagementEnabledForMessages, isContextManagementEnabledForResponses } = await import("./src/lib/config"); console.log(JSON.stringify({ messages: isContextManagementEnabledForMessages(), responses: isContextManagementEnabledForResponses() }));',
    )

    expect(JSON.parse(output)).toEqual({
      messages: false,
      responses: false,
    })
    expect(readConfigFile(configPath).contextManagement).toBeUndefined()
  })

  test("adds Responses image budget defaults", () => {
    const tempDir = createTempConfigDir()
    const configPath = path.join(tempDir, "config.json")

    const output = runScript(
      tempDir,
      'const config = await import("./src/lib/config"); console.log(JSON.stringify({ enabled: config.isResponsesImageOptimizationEnabled(), budget: config.getResponsesPayloadBudgetBytes(), retryBudget: config.getResponsesPayloadRetryBudgetBytes(), hardLimit: config.getResponsesPayloadSendHardLimitBytes(), maxInputImageBytes: config.getResponsesImageMaxInputImageBytes(), compression: config.isResponsesImageCompressionEnabled(), concurrency: config.getResponsesImageCompressionConcurrency(), cacheBytes: config.getResponsesImageCompressionCacheBytes(), maxActions: config.getResponsesImageCompressionMaxActionsPerRequest(), latestHardLimitReplacement: config.isResponsesImageLatestReplacementAllowedOnHardLimit(), retryRequiresHttp: config.shouldResponsesImageRetryRequireHttp() }));',
    )

    expect(JSON.parse(output)).toEqual({
      budget: 31_457_280,
      cacheBytes: 268_435_456,
      compression: true,
      concurrency: 8,
      enabled: true,
      hardLimit: 33_538_048,
      latestHardLimitReplacement: true,
      maxActions: 64,
      maxInputImageBytes: 25_149_440,
      retryBudget: 29_360_128,
      retryRequiresHttp: true,
    })
    const persisted = readConfigFile(configPath)
    expect(persisted.responsesImageCompression).toBeUndefined()
    expect(persisted.responsesImageMaxInputImageBytes).toBeUndefined()
    expect(persisted.responsesImageOptimization).toBeUndefined()
    expect(persisted.responsesPayloadBudgetBytes).toBeUndefined()
  })

  test("migrates the legacy Responses image budget defaults", () => {
    const tempDir = createTempConfigDir()
    const configPath = writeConfigFile(tempDir, {
      responsesPayloadBudgetBytes: 4_980_736,
      responsesPayloadRetryBudgetBytes: 4_718_592,
      responsesPayloadSendHardLimitBytes: 5_226_496,
    })

    runScript(
      tempDir,
      'const { mergeConfigWithDefaults } = await import("./src/lib/config"); mergeConfigWithDefaults();',
    )

    const persisted = readConfigFile(configPath)
    expect(persisted.responsesImageMaxInputImageBytes).toBeUndefined()
    expect(persisted.responsesPayloadBudgetBytes).toBeUndefined()
    expect(persisted.responsesPayloadRetryBudgetBytes).toBeUndefined()
    expect(persisted.responsesPayloadSendHardLimitBytes).toBeUndefined()
  })

  test("preserves custom image budgets without materializing the default image limit", () => {
    const tempDir = createTempConfigDir()
    const configPath = writeConfigFile(tempDir, {
      responsesPayloadBudgetBytes: 4_900_000,
      responsesPayloadRetryBudgetBytes: 4_600_000,
      responsesPayloadSendHardLimitBytes: 5_100_000,
    })

    runScript(
      tempDir,
      'const { mergeConfigWithDefaults } = await import("./src/lib/config"); mergeConfigWithDefaults();',
    )

    expect(readConfigFile(configPath)).toMatchObject({
      responsesPayloadBudgetBytes: 4_900_000,
      responsesPayloadRetryBudgetBytes: 4_600_000,
      responsesPayloadSendHardLimitBytes: 5_100_000,
    })
    expect(
      readConfigFile(configPath).responsesImageMaxInputImageBytes,
    ).toBeUndefined()
  })

  test("normalizes invalid Responses image budget config values", () => {
    const tempDir = createTempConfigDir()
    writeConfigFile(tempDir, {
      responsesImageCompressionCacheBytes: -1,
      responsesImageCompressionConcurrency: 99,
      responsesImageCompressionMaxActionsPerRequest: -1,
      responsesImageMaxInputImageBytes: -1,
      responsesPayloadBudgetBytes: 10,
      responsesPayloadRetryBudgetBytes: 40_000_000,
      responsesPayloadSendHardLimitBytes: 20,
    })

    const output = runScript(
      tempDir,
      'const config = await import("./src/lib/config"); console.log(JSON.stringify({ budget: config.getResponsesPayloadBudgetBytes(), retryBudget: config.getResponsesPayloadRetryBudgetBytes(), hardLimit: config.getResponsesPayloadSendHardLimitBytes(), maxInputImageBytes: config.getResponsesImageMaxInputImageBytes(), concurrency: config.getResponsesImageCompressionConcurrency(), cacheBytes: config.getResponsesImageCompressionCacheBytes(), maxActions: config.getResponsesImageCompressionMaxActionsPerRequest() }));',
    )

    expect(JSON.parse(output)).toEqual({
      budget: 31_457_280,
      cacheBytes: 268_435_456,
      concurrency: 8,
      hardLimit: 33_538_048,
      maxActions: 64,
      maxInputImageBytes: 25_149_440,
      retryBudget: 29_360_128,
    })
  })

  test("allows overriding context management per endpoint", () => {
    const tempDir = createTempConfigDir()
    writeConfigFile(tempDir, {
      configSchemaVersion: 2,
      contextManagement: {
        messages: true,
        responses: true,
      },
    })

    const output = runScript(
      tempDir,
      'const { isContextManagementEnabledForMessages, isContextManagementEnabledForResponses } = await import("./src/lib/config"); console.log(JSON.stringify({ messages: isContextManagementEnabledForMessages(), responses: isContextManagementEnabledForResponses() }));',
    )

    expect(JSON.parse(output)).toEqual({
      messages: true,
      responses: true,
    })
  })

  test("marks an unversioned legacy messages=true config for an explicit ownership decision", () => {
    const tempDir = createTempConfigDir()
    const configPath = writeConfigFile(tempDir, {
      contextManagement: {
        messages: true,
        responses: false,
      },
    })

    const output = runScriptWithOutput(
      tempDir,
      'const config = await import("./src/lib/config"); config.mergeConfigWithDefaults(); console.log(JSON.stringify({ enabled: config.isContextManagementEnabledForMessages() }));',
    )

    expect(readConfigFile(configPath)).toMatchObject({
      configSchemaVersion: 2,
      contextManagement: {
        messages: true,
      },
      migrationState: {
        contextManagementMessages: "pending_user_decision",
      },
    })
    expect(output.stderr).toContain(
      "contextManagement.messages is temporarily disabled while this decision is pending",
    )
    expect(JSON.parse(output.stdout)).toEqual({ enabled: false })
  })

  test("preserves a versioned explicit messages=true choice while removing inert legacy fields", () => {
    const tempDir = createTempConfigDir()
    const configPath = writeConfigFile(tempDir, {
      configSchemaVersion: 1,
      contextManagement: {
        messages: true,
        responses: false,
      },
      responsesApiContextManagementModels: ["gpt-5.6-sol"],
      useFunctionApplyPatch: true,
    })

    const output = runScript(
      tempDir,
      'const config = await import("./src/lib/config"); config.mergeConfigWithDefaults(); console.log(JSON.stringify({ enabled: config.isContextManagementEnabledForMessages() }));',
    )

    const migrated = readConfigFile(configPath)
    expect(migrated.contextManagement?.messages).toBe(true)
    expect(migrated.migrationState).toBeUndefined()
    expect(migrated.responsesApiContextManagementModels).toBeUndefined()
    expect(migrated.useFunctionApplyPatch).toBeUndefined()
    expect(JSON.parse(output)).toEqual({ enabled: true })
  })

  test("does not downgrade a config written by a future schema", () => {
    const tempDir = createTempConfigDir()
    const configPath = writeConfigFile(tempDir, {
      configSchemaVersion: 99,
      contextManagement: {
        messages: true,
        responses: false,
      },
    })

    runScript(
      tempDir,
      'const { mergeConfigWithDefaults } = await import("./src/lib/config"); mergeConfigWithDefaults();',
    )

    const migrated = readConfigFile(configPath)
    expect(migrated.configSchemaVersion).toBe(99)
    expect(migrated.contextManagement?.messages).toBe(true)
    expect(migrated.migrationState).toBeUndefined()
  })

  test("does not persist static model Responses API compact thresholds", () => {
    const tempDir = createTempConfigDir()
    const configPath = path.join(tempDir, "config.json")

    const output = runScript(
      tempDir,
      'const { getModelResponsesApiCompactThreshold } = await import("./src/lib/config"); console.log(JSON.stringify({ gpt54: getModelResponsesApiCompactThreshold("gpt-5.4") ?? null, gpt55: getModelResponsesApiCompactThreshold("gpt-5.5") ?? null, gpt56sol: getModelResponsesApiCompactThreshold("gpt-5.6-sol") ?? null, gpt56terra: getModelResponsesApiCompactThreshold("gpt-5.6-terra") ?? null, gpt56luna: getModelResponsesApiCompactThreshold("gpt-5.6-luna") ?? null, unknown: getModelResponsesApiCompactThreshold("gpt-test") ?? null }));',
    )

    expect(JSON.parse(output)).toEqual({
      gpt54: null,
      gpt55: null,
      gpt56luna: null,
      gpt56sol: null,
      gpt56terra: null,
      unknown: null,
    })
    expect(
      readConfigFile(configPath).modelResponsesApiCompactThresholds,
    ).toBeUndefined()
  })

  test("does not add quick provider templates by default", () => {
    const tempDir = createTempConfigDir()
    const configPath = path.join(tempDir, "config.json")

    runScript(
      tempDir,
      'const { mergeConfigWithDefaults } = await import("./src/lib/config"); mergeConfigWithDefaults();',
    )

    expect(readConfigFile(configPath).providers).toBeUndefined()
  })

  test("isGpt56OrAbove detects gpt-5.6 and above models", () => {
    const tempDir = createTempConfigDir()

    const output = runScript(
      tempDir,
      'const { isGpt56OrAbove } = await import("./src/lib/config"); console.log(JSON.stringify({ "gpt-5.5": isGpt56OrAbove("gpt-5.5"), "gpt-5.6": isGpt56OrAbove("gpt-5.6"), "gpt-5.6-sol": isGpt56OrAbove("gpt-5.6-sol"), "gpt-5.6-terra": isGpt56OrAbove("gpt-5.6-terra"), "gpt-5.6-luna": isGpt56OrAbove("gpt-5.6-luna"), "gpt-6": isGpt56OrAbove("gpt-6"), "gpt-5-mini": isGpt56OrAbove("gpt-5-mini"), "claude-opus": isGpt56OrAbove("claude-opus") }));',
    )

    expect(JSON.parse(output)).toEqual({
      "gpt-5.5": false,
      "gpt-5.6": true,
      "gpt-5.6-sol": true,
      "gpt-5.6-terra": true,
      "gpt-5.6-luna": true,
      "gpt-6": true,
      "gpt-5-mini": false,
      "claude-opus": false,
    })
  })

  test("does not add missing quick providers to existing provider config", () => {
    const tempDir = createTempConfigDir()
    const configPath = writeConfigFile(tempDir, {
      providers: {
        deepseek: {
          apiKey: "custom-key",
          baseUrl: "https://custom.deepseek.example",
          enabled: false,
          type: "anthropic",
        },
      },
    })

    runScript(
      tempDir,
      'const { mergeConfigWithDefaults } = await import("./src/lib/config"); mergeConfigWithDefaults();',
    )

    expect(readConfigFile(configPath).providers).toEqual({
      deepseek: {
        apiKey: "custom-key",
        baseUrl: "https://custom.deepseek.example",
        enabled: false,
        type: "anthropic",
      },
    })
  })

  test("allows overriding model Responses API compact thresholds", () => {
    const tempDir = createTempConfigDir()
    writeConfigFile(tempDir, {
      modelResponsesApiCompactThresholds: {
        "gpt-5.4": 123456,
      },
    })

    const output = runScript(
      tempDir,
      'const { getModelResponsesApiCompactThreshold } = await import("./src/lib/config"); console.log(JSON.stringify({ gpt54: getModelResponsesApiCompactThreshold("gpt-5.4"), gpt55: getModelResponsesApiCompactThreshold("gpt-5.5") ?? null, gpt56: getModelResponsesApiCompactThreshold("gpt-5.6-sol") ?? null }));',
    )

    expect(JSON.parse(output)).toEqual({
      gpt54: 123456,
      gpt55: null,
      gpt56: null,
    })
  })

  test("removes legacy compact thresholds while preserving other overrides", () => {
    const tempDir = createTempConfigDir()
    const configPath = writeConfigFile(tempDir, {
      modelResponsesApiCompactThresholds: {
        "gpt-5.4": 217600,
        "gpt-5.5": 217600,
        "gpt-5.6-sol": 231200,
        "gpt-5.6-terra": 231200,
        "gpt-5.6-luna": 231200,
        "gpt-6": 100000,
      },
    })

    runScript(
      tempDir,
      'const { mergeConfigWithDefaults } = await import("./src/lib/config"); mergeConfigWithDefaults(); mergeConfigWithDefaults();',
    )

    expect(
      readConfigFile(configPath).modelResponsesApiCompactThresholds,
    ).toEqual({
      "gpt-6": 100000,
    })
  })

  test("preserves non-legacy compact threshold values", () => {
    const tempDir = createTempConfigDir()
    const configPath = writeConfigFile(tempDir, {
      modelResponsesApiCompactThresholds: {
        "gpt-5.4": 217601,
        "gpt-5.5": 200000,
        "gpt-5.6-sol": 231201,
      },
    })

    runScript(
      tempDir,
      'const { mergeConfigWithDefaults } = await import("./src/lib/config"); mergeConfigWithDefaults();',
    )

    expect(
      readConfigFile(configPath).modelResponsesApiCompactThresholds,
    ).toEqual({
      "gpt-5.4": 217601,
      "gpt-5.5": 200000,
      "gpt-5.6-sol": 231201,
    })
  })

  test("allows codex to be configured in config.providers", () => {
    const tempDir = createTempConfigDir()
    writeConfigFile(tempDir, {
      providers: {
        codex: {
          type: "openai-responses",
          authType: "oauth2",
          baseUrl: "https://chatgpt.com/backend-api",
        },
      },
    })

    const output = runScript(
      tempDir,
      'const { getProviderConfig } = await import("./src/lib/config"); console.log(JSON.stringify(getProviderConfig("codex")));',
    )

    expect(JSON.parse(output)).toMatchObject({
      name: "codex",
      type: "openai-responses",
      authType: "oauth2",
      baseUrl: "https://chatgpt.com/backend-api",
      apiKey: "",
    })
  })

  test("keeps Responses context management explicit for builtin and generic providers", () => {
    const tempDir = createTempConfigDir()
    writeConfigFile(tempDir, {
      providers: {
        custom: {
          apiKey: "custom-key",
          baseUrl: "https://custom.example",
          capabilities: {
            responsesContextManagement: true,
          },
          type: "openai-responses",
        },
      },
    })

    const output = runScript(
      tempDir,
      'const config = await import("./src/lib/config"); const custom = config.getProviderConfig("custom"); const base = { apiKey: "", authType: "oauth2", baseUrl: "https://example.test", type: "openai-responses" }; console.log(JSON.stringify({ codex: config.supportsProviderResponsesContextManagement({ ...base, name: "codex" }), copilot: config.supportsProviderResponsesContextManagement({ ...base, name: "copilot" }), custom: custom && config.supportsProviderResponsesContextManagement(custom), unknown: config.supportsProviderResponsesContextManagement({ ...base, name: "unknown" }) }));',
    )

    expect(JSON.parse(output)).toEqual({
      codex: true,
      copilot: true,
      custom: true,
      unknown: false,
    })
  })

  test("keeps copilot reserved for config.providers", () => {
    const tempDir = createTempConfigDir()
    writeConfigFile(tempDir, {
      providers: {
        copilot: {
          type: "openai-compatible",
          baseUrl: "https://example.com",
          apiKey: "provider-key",
        },
      },
    })

    const output = runScript(
      tempDir,
      'const { getProviderConfig } = await import("./src/lib/config"); console.log(JSON.stringify(getProviderConfig("copilot")));',
    )

    expect(JSON.parse(output)).toBeNull()
  })

  test("requires apiKey for non-codex oauth2 providers", () => {
    const tempDir = createTempConfigDir()
    writeConfigFile(tempDir, {
      providers: {
        custom: {
          type: "openai-responses",
          authType: "oauth2",
          baseUrl: "https://example.com",
        },
      },
    })

    const output = runScript(
      tempDir,
      'const { getProviderConfig } = await import("./src/lib/config"); console.log(JSON.stringify(getProviderConfig("custom")));',
    )

    expect(JSON.parse(output)).toBeNull()
  })

  test("returns commentary prompt for gpt-5.3+ models by default", () => {
    const tempDir = createTempConfigDir()
    writeConfigFile(tempDir, {})

    const output = runScript(
      tempDir,
      'const { getExtraPromptForModel } = await import("./src/lib/config"); console.log(JSON.stringify({ codex: getExtraPromptForModel("gpt-5.3-codex").length > 0, gpt54: getExtraPromptForModel("gpt-5.4").length > 0, gpt55: getExtraPromptForModel("gpt-5.5").length > 0, gpt6: getExtraPromptForModel("gpt-6").length > 0, gpt52: getExtraPromptForModel("gpt-5.2").length > 0, unknown: getExtraPromptForModel("gpt-test") }));',
    )

    expect(JSON.parse(output)).toEqual({
      codex: true,
      gpt54: true,
      gpt55: true,
      gpt6: true,
      gpt52: false,
      unknown: "",
    })
  })

  test("returns xhigh reasoning effort for gpt-5.3+ models by default", () => {
    const tempDir = createTempConfigDir()
    writeConfigFile(tempDir, {})

    const output = runScript(
      tempDir,
      'const { getReasoningEffortForModel } = await import("./src/lib/config"); console.log(JSON.stringify({ codex: getReasoningEffortForModel("gpt-5.3-codex"), gpt54: getReasoningEffortForModel("gpt-5.4"), gpt55: getReasoningEffortForModel("gpt-5.5"), gpt6: getReasoningEffortForModel("gpt-6"), gpt52: getReasoningEffortForModel("gpt-5.2"), unknown: getReasoningEffortForModel("gpt-test") }));',
    )

    expect(JSON.parse(output)).toEqual({
      codex: "xhigh",
      gpt54: "xhigh",
      gpt55: "xhigh",
      gpt6: "xhigh",
      gpt52: "high",
      unknown: "high",
    })
  })

  test("user extraPrompts override takes priority over fallback", () => {
    const tempDir = createTempConfigDir()
    writeConfigFile(tempDir, {
      extraPrompts: {
        "gpt-5.4": "custom prompt",
      },
    })

    const output = runScript(
      tempDir,
      'const { getExtraPromptForModel } = await import("./src/lib/config"); console.log(JSON.stringify({ gpt54: getExtraPromptForModel("gpt-5.4"), gpt55HasPrompt: getExtraPromptForModel("gpt-5.5").length > 0 }));',
    )

    expect(JSON.parse(output)).toEqual({
      gpt54: "custom prompt",
      gpt55HasPrompt: true,
    })
  })

  test("user modelReasoningEfforts override takes priority over fallback", () => {
    const tempDir = createTempConfigDir()
    writeConfigFile(tempDir, {
      modelReasoningEfforts: {
        "gpt-5.4": "medium",
      },
    })

    const output = runScript(
      tempDir,
      'const { getReasoningEffortForModel } = await import("./src/lib/config"); console.log(JSON.stringify({ gpt54: getReasoningEffortForModel("gpt-5.4"), gpt55: getReasoningEffortForModel("gpt-5.5") }));',
    )

    expect(JSON.parse(output)).toEqual({
      gpt54: "medium",
      gpt55: "xhigh",
    })
  })

  test("does not persist gpt-5.3+ extraPrompts in config file", () => {
    const tempDir = createTempConfigDir()
    const configPath = writeConfigFile(tempDir, {})

    runScript(
      tempDir,
      'const { mergeConfigWithDefaults } = await import("./src/lib/config"); mergeConfigWithDefaults();',
    )

    const writtenConfig = readConfigFile(configPath)
    expect(writtenConfig.extraPrompts).toBeUndefined()
  })

  test("does not persist gpt-5.3+ modelReasoningEfforts in config file", () => {
    const tempDir = createTempConfigDir()
    const configPath = writeConfigFile(tempDir, {})

    runScript(
      tempDir,
      'const { mergeConfigWithDefaults } = await import("./src/lib/config"); mergeConfigWithDefaults();',
    )

    expect(readConfigFile(configPath).modelReasoningEfforts).toBeUndefined()
  })
})
