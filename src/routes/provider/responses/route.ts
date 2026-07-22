import { Hono } from "hono"

import { forwardError } from "~/lib/error"
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
      const payload = (await new Response(rawBody).json()) as ResponsesPayload
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
