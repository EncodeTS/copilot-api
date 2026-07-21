import { Hono } from "hono"

import { forwardError } from "~/lib/error"

import { handleCountTokens } from "./count-tokens-handler"
import { handleCompletion } from "./handler"
import { adaptMessagesRouteError } from "./route-error"

export const messageRoutes = new Hono()

messageRoutes.post("/", async (c) => {
  try {
    return await handleCompletion(c)
  } catch (error) {
    return await forwardError(c, adaptMessagesRouteError(error))
  }
})

messageRoutes.post("/count_tokens", async (c) => {
  try {
    return await handleCountTokens(c)
  } catch (error) {
    return await forwardError(c, adaptMessagesRouteError(error))
  }
})
