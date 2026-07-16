import type { Context } from "hono"

import { createHandlerLogger, debugJson } from "~/lib/logger"
import {
  generateRequestIdFromPayload,
  getRootSessionId,
  getUUID,
} from "~/lib/utils"

import {
  handlePreparedChatCompletions,
  handlePreparedMessagesApi,
  handlePreparedResponsesApi,
  type FlowBaseOptions,
} from "~/routes/messages/api-flows"
import type { PreparedCopilotMessagesRequest } from "~/routes/messages/prepared-messages/core"
import { getPreparedCopilotMessagesPlan } from "~/routes/messages/prepared-messages/core"

const logger = createHandlerLogger("prepared-messages-generation")

export const preparedMessagesGenerationDependencies = {
  handleWithChatCompletions: handlePreparedChatCompletions,
  handleWithMessagesApi: handlePreparedMessagesApi,
  handleWithResponsesApi: handlePreparedResponsesApi,
}

export const generatePreparedCopilotMessages = async (
  c: Context,
  prepared: PreparedCopilotMessagesRequest,
): Promise<Response> => {
  const plan = getPreparedCopilotMessagesPlan(prepared)
  const { sourcePayload, subagentMarker } = plan
  if (subagentMarker) {
    debugJson(logger, "Detected Subagent marker:", subagentMarker)
  }

  const reasoningRecoverySessionId = getRootSessionId(sourcePayload, c)
  let sessionId = reasoningRecoverySessionId
  const requestId = generateRequestIdFromPayload(
    plan.requestIdentityPayload,
    sessionId,
  )
  logger.debug("Generated request ID:", requestId)
  if (!sessionId) {
    sessionId = getUUID(requestId)
  }
  logger.debug("Extracted session ID:", sessionId)

  const options: FlowBaseOptions & {
    anthropicBetaHeader?: string
    selectedModel?: typeof plan.endpointModel
  } = {
    anthropicBetaHeader: c.req.header("anthropic-beta"),
    compactType: plan.compactType,
    logger,
    reasoningRecoverySessionId,
    requestId,
    selectedModel: plan.endpointModel,
    sessionId,
    signal: c.req.raw.signal,
    subagentMarker,
  }

  if (plan.kind === "messages") {
    return await preparedMessagesGenerationDependencies.handleWithMessagesApi(
      c,
      plan.payload,
      options,
    )
  }
  if (plan.kind === "responses") {
    return await preparedMessagesGenerationDependencies.handleWithResponsesApi(
      c,
      sourcePayload,
      options,
      plan.payload,
      plan.transport,
    )
  }
  return await preparedMessagesGenerationDependencies.handleWithChatCompletions(
    c,
    sourcePayload,
    options,
    plan.payload,
  )
}
