import { afterEach, expect, test } from "bun:test"

import type { ResponsesPayload } from "../src/services/copilot/create-responses"

import { getModels as getCodexModels } from "../src/services/codex/get-models"
import {
  applyResponsesApiContextManagement,
  resolveResponsesCompactThreshold,
  resolveResponsesPromptLimit,
  responsesUtilsDependencies,
} from "../src/routes/responses/utils"

const originalDependencies = { ...responsesUtilsDependencies }

afterEach(() => {
  Object.assign(responsesUtilsDependencies, originalDependencies)
})

test("derives compact thresholds from model prompt limits with headroom", () => {
  const cases = [
    [128_000, 96_000],
    [272_000, 240_000],
    [372_000, 334_800],
    [922_000, 829_800],
  ] as const

  for (const [maxPromptTokens, expected] of cases) {
    expect(
      resolveResponsesCompactThreshold({
        max_prompt_tokens: maxPromptTokens,
      }),
    ).toBe(expected)
  }
})

test("falls back from context and output limits when prompt limit is missing", () => {
  const limits = {
    max_context_window_tokens: 1_050_000,
    max_output_tokens: 128_000,
  }

  expect(resolveResponsesPromptLimit(limits)).toBe(922_000)
  expect(resolveResponsesCompactThreshold(limits)).toBe(829_800)
})

test("matches official Codex effective context thresholds", () => {
  const models = getCodexModels().data
  const expectedThresholds: Record<string, number> = {
    "gpt-5.4": 240_000,
    "gpt-5.4-mini": 240_000,
    "gpt-5.5": 240_000,
    "gpt-5.6-luna": 334_800,
    "gpt-5.6-sol": 334_800,
    "gpt-5.6-terra": 334_800,
  }

  for (const [modelId, expected] of Object.entries(expectedThresholds)) {
    const limits = models.find((model) => model.id === modelId)?.capabilities
      .limits
    expect(resolveResponsesCompactThreshold(limits)).toBe(expected)
  }
})

test("uses bounded fallback thresholds when model metadata is missing", () => {
  expect(resolveResponsesCompactThreshold()).toBe(168_000)
  expect(resolveResponsesCompactThreshold(undefined, 0.8)).toBe(160_000)
})

test("keeps explicit model overrides ahead of the dynamic threshold", () => {
  responsesUtilsDependencies.getModelResponsesApiCompactThreshold = () =>
    123_456
  responsesUtilsDependencies.isContextManagementEnabledForMessages = () => true
  const payload: ResponsesPayload = {
    input: "hello",
    model: "gpt-test",
  }

  expect(
    applyResponsesApiContextManagement(
      payload,
      { max_prompt_tokens: 922_000 },
      { source: "messages" },
    ),
  ).toEqual({
    owner: "gateway",
    injected: true,
    shouldPruneInput: true,
  })
  expect(payload.context_management).toEqual([
    {
      type: "compaction",
      compact_threshold: 123_456,
    },
  ])
})

test("does not disable configured context management based on a GPT-5.6 model name", () => {
  responsesUtilsDependencies.getModelResponsesApiCompactThreshold = () =>
    undefined
  responsesUtilsDependencies.isContextManagementEnabledForMessages = () => true
  const payload: ResponsesPayload = {
    input: "hello",
    model: "gpt-5.6-sol",
  }

  expect(
    applyResponsesApiContextManagement(
      payload,
      { max_prompt_tokens: 372_000 },
      { source: "messages" },
    ),
  ).toEqual({
    owner: "gateway",
    injected: true,
    shouldPruneInput: true,
  })
  expect(payload.context_management).toEqual([
    {
      type: "compaction",
      compact_threshold: 334_800,
    },
  ])
})

test("does not inject native Responses compaction unless enabled", () => {
  responsesUtilsDependencies.isContextManagementEnabledForResponses = () =>
    false
  const payload: ResponsesPayload = {
    input: "hello",
    model: "gpt-test",
  }

  expect(
    applyResponsesApiContextManagement(
      payload,
      { max_prompt_tokens: 922_000 },
      { source: "responses" },
    ),
  ).toEqual({
    owner: "none",
    injected: false,
    shouldPruneInput: false,
  })
  expect(payload.context_management).toBeUndefined()
})

test("preserves client-provided context management", () => {
  responsesUtilsDependencies.isContextManagementEnabledForResponses = () =>
    false
  const payload: ResponsesPayload = {
    context_management: [{ type: "compaction", compact_threshold: 345_678 }],
    input: "hello",
    model: "gpt-test",
  }

  expect(
    applyResponsesApiContextManagement(
      payload,
      { max_prompt_tokens: 922_000 },
      { source: "responses" },
    ),
  ).toEqual({
    owner: "client",
    injected: false,
    shouldPruneInput: false,
  })
  expect(payload.context_management).toEqual([
    {
      type: "compaction",
      compact_threshold: 345_678,
    },
  ])
})
