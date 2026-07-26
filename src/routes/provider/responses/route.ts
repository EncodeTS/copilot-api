import { Hono } from "hono"

import { forwardError } from "~/lib/error"
import {
  assertPayloadShape,
  createInvalidPayloadError,
  RESPONSES_SHAPE,
} from "~/lib/request-payload-validation"
import type { ResponsesPayload } from "~/services/copilot/create-responses"

import {
  handleProviderResponsesForProvider,
  type ProviderResponsesHandler,
} from "./handler"

export interface ProviderResponsesRoutesComposition {
  responses?: ProviderResponsesHandler
}

export const createProviderResponsesRoutes = (
  composition: ProviderResponsesRoutesComposition = {},
): Hono => {
  const responses = Object.freeze({
    ...(composition.responses ?? {
      handleForProvider: handleProviderResponsesForProvider,
    }),
  })
  const routes = new Hono()
  routes.post("/", async (c) => {
    try {
      const provider = c.req.param("provider") ?? ""
      const rawBody = new Uint8Array(await c.req.raw.arrayBuffer())
      let parsedBody: unknown
      try {
        parsedBody = await new Response(rawBody).json()
      } catch {
        throw createInvalidPayloadError(
          "openai",
          "The request body is not valid JSON.",
        )
      }
      const payload = assertPayloadShape(
        "openai",
        parsedBody,
        RESPONSES_SHAPE,
      ) as ResponsesPayload
      return await responses.handleForProvider(c, {
        payload,
        provider,
        rawBody,
      })
    } catch (error) {
      return await forwardError(c, error)
    }
  })
  return routes
}

export const providerResponsesRoutes = createProviderResponsesRoutes()
