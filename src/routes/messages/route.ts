import { Hono } from "hono"

import { forwardError } from "~/lib/error"

import { handleCountTokens } from "./count-tokens-handler"
import { handleCompletion, type MessagesHandler } from "./handler"
import { adaptMessagesRouteError } from "./route-error"

export interface MessageRoutesComposition {
  countTokens?: typeof handleCountTokens
  messages?: MessagesHandler
}

export const createMessageRoutes = (
  composition: MessageRoutesComposition = {},
): Hono => {
  const dependencies = Object.freeze({
    countTokens: composition.countTokens ?? handleCountTokens,
    messages: composition.messages ?? handleCompletion,
  })
  const routes = new Hono()

  routes.post("/", async (c) => {
    try {
      return await dependencies.messages(c)
    } catch (error) {
      return await forwardError(c, adaptMessagesRouteError(error))
    }
  })

  routes.post("/count_tokens", async (c) => {
    try {
      return await dependencies.countTokens(c)
    } catch (error) {
      return await forwardError(c, adaptMessagesRouteError(error))
    }
  })

  return routes
}

export const messageRoutes = createMessageRoutes()
