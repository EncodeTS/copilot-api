import { Hono, type Context } from "hono"

import { forwardError } from "~/lib/error"
import { createHandlerLogger, debugJson, debugJsonAsync } from "~/lib/logger"
import { resolveProviderConfig } from "~/lib/provider-resolver"
import {
  forwardCodexImages,
  type CodexImagesOperation,
} from "~/services/codex/images"
import { createProviderProxyResponse } from "~/services/providers/provider-proxy"

const logger = createHandlerLogger("images-handler")

export const imageRoutes = new Hono()
export const imageRouteDependencies = { debugJsonAsync }

function getContentMetadata(headers: Headers) {
  return {
    contentType: headers.get("content-type"),
    contentLength: headers.get("content-length"),
  }
}

async function handleCodexImages(
  c: Context,
  operation: CodexImagesOperation,
): Promise<Response> {
  try {
    const codexProviderConfig = await resolveProviderConfig("codex")
    if (!codexProviderConfig) {
      return c.json(
        {
          error: {
            message: "Provider 'codex' not found or disabled",
            type: "invalid_request_error",
          },
        },
        404,
      )
    }

    if (operation === "generations") {
      await imageRouteDependencies.debugJsonAsync(
        logger,
        "images.generations.codex.request",
        async () => ({
          body: await c.req.raw.clone().text(),
        }),
      )
    } else {
      debugJson(
        logger,
        "images.edits.codex.request",
        getContentMetadata(c.req.raw.headers),
      )
    }

    const upstreamResponse = await forwardCodexImages(c.req.raw, operation)
    debugJson(logger, `images.${operation}.codex.response`, {
      ...getContentMetadata(upstreamResponse.headers),
      statusCode: upstreamResponse.status,
    })
    return createProviderProxyResponse(upstreamResponse)
  } catch (error) {
    logger.error(`images.${operation}.codex.error`, { error })
    return await forwardError(c, error)
  }
}

imageRoutes.post("/generations", (c) => handleCodexImages(c, "generations"))
imageRoutes.post("/edits", (c) => handleCodexImages(c, "edits"))
