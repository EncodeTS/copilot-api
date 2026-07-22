import { Hono } from "hono"

import { forwardError } from "~/lib/error"

import { handleProviderCountTokens } from "./count-tokens-handler"
import {
  handleProviderMessages,
  handleProviderMessagesForProvider,
  type ProviderMessagesHandler,
} from "./handler"

export interface ProviderMessageRoutesComposition {
  countTokens?: typeof handleProviderCountTokens
  messages?: ProviderMessagesHandler
}

export const createProviderMessageRoutes = (
  composition: ProviderMessageRoutesComposition = {},
): Hono => {
  const defaultMessages: ProviderMessagesHandler = {
    handle: handleProviderMessages,
    handleForProvider: handleProviderMessagesForProvider,
  }
  const dependencies = Object.freeze({
    countTokens: composition.countTokens ?? handleProviderCountTokens,
    messages: Object.freeze({
      ...(composition.messages ?? defaultMessages),
    }),
  })
  const routes = new Hono()

  routes.post("/", async (c) => {
    try {
      return await dependencies.messages.handle(c)
    } catch (error) {
      return await forwardError(c, error)
    }
  })

  routes.post("/count_tokens", async (c) => {
    try {
      return await dependencies.countTokens(c)
    } catch (error) {
      return await forwardError(c, error)
    }
  })

  return routes
}

export const providerMessageRoutes = createProviderMessageRoutes()
