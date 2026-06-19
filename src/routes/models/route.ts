import { Hono } from "hono"

import { forwardError } from "~/lib/error"
import { toClientModelId } from "~/lib/models"
import { state } from "~/lib/state"

export const modelRoutes = new Hono()

modelRoutes.get("/", async (c) => {
  try {
    const models = state.models?.data.map((model) => {
      const capabilities = model.capabilities
      const contextWindow = capabilities?.limits?.max_context_window_tokens ?? 0
      const clientId = toClientModelId(model.id)
      const is1m = contextWindow >= 1_000_000
      return {
        claude_model_id: is1m ? `${clientId}[1m]` : clientId,
        ...model,
        id: clientId,
        object: "model",
        type: "model",
        created: 0,
        created_at: new Date(0).toISOString(),
        owned_by: model.vendor,
        display_name: model.name,
      }
    })

    return c.json({
      object: "list",
      data: models,
      has_more: false,
    })
  } catch (error) {
    return await forwardError(c, error)
  }
})
