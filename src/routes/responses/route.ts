import { Hono } from "hono"

import { forwardError } from "~/lib/error"

import { handleResponses } from "./handler"

export interface ResponsesRoutesComposition {
  responses?: typeof handleResponses
}

export const createResponsesRoutes = (
  composition: ResponsesRoutesComposition = {},
): Hono => {
  const responses = composition.responses ?? handleResponses
  const routes = new Hono()
  routes.post("/", async (c) => {
    try {
      return await responses(c)
    } catch (error) {
      return await forwardError(c, error)
    }
  })
  return routes
}

export const responsesRoutes = createResponsesRoutes()
