import type { Context } from "hono"
import { streamSSE, type SSEStreamingApi } from "hono/streaming"

import { getRootSessionId } from "~/lib/utils"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"
import type { PreparedMessagesPolicySnapshot } from "~/routes/messages/prepared-messages/policy"

export interface MessagesResponseContext {
  json: (body: unknown, status?: number) => Response
  streamSSE: (callback: (stream: SSEStreamingApi) => Promise<void>) => Response
}

export interface MessagesRequestContext {
  anthropicBetaHeader?: string
  reasoningRecoverySessionId?: string
  response: MessagesResponseContext
  signal: AbortSignal
  policy: PreparedMessagesPolicySnapshot
}

/** Extract every Hono-specific request/response capability at the route seam. */
export const createMessagesRequestContext = (
  c: Context,
  payload: AnthropicMessagesPayload,
  policy: PreparedMessagesPolicySnapshot,
): MessagesRequestContext => {
  const response = createMessagesResponseContext(c)

  return Object.freeze({
    anthropicBetaHeader: c.req.header("anthropic-beta"),
    reasoningRecoverySessionId: getRootSessionId(payload, c),
    policy,
    response,
    signal: c.req.raw.signal,
  })
}

export const createMessagesResponseContext = (
  c: Context,
): MessagesResponseContext => {
  const json = c.json.bind(c) as unknown as MessagesResponseContext["json"]
  const response: MessagesResponseContext = {
    json,
    streamSSE: (callback) => streamSSE(c, callback),
  }
  return Object.freeze(response)
}
