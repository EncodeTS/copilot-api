import { Hono, type Context } from "hono"

import { AuthRequestError } from "~/lib/auth-request"
import type { ResolvedProviderConfig } from "~/lib/config"
import { forwardError } from "~/lib/error"
import { createHandlerLogger, debugJson } from "~/lib/logger"
import { resolveProviderConfig } from "~/lib/provider-resolver"
import {
  createProviderImagesPort,
  type ProviderImagesOperation,
  type ProviderImagesPort,
} from "~/services/providers/provider-images-port"

const logger = createHandlerLogger("images-handler")

export interface ImageDiagnosticFields {
  contentLength: string | null
  contentType: string | null
  provider: string
  statusCode?: number
}

export type ImageDiagnostic = (
  event: string,
  fields: ImageDiagnosticFields,
) => void

export interface ImageRoutesComposition {
  createProviderImagesPort?: (
    providerConfig: ResolvedProviderConfig,
  ) => ProviderImagesPort
  diagnostic?: ImageDiagnostic
  resolveProviderConfig?: typeof resolveProviderConfig
}

export const createImageRoutes = (
  composition: ImageRoutesComposition = {},
): Hono => {
  const dependencies = Object.freeze({
    createProviderImagesPort:
      composition.createProviderImagesPort ?? createProviderImagesPort,
    diagnostic:
      composition.diagnostic
      ?? ((event: string, fields: ImageDiagnosticFields) =>
        debugJson(logger, event, fields)),
    resolveProviderConfig:
      composition.resolveProviderConfig ?? resolveProviderConfig,
  })
  const routes = new Hono()

  const handle = async (
    c: Context,
    operation: ProviderImagesOperation,
  ): Promise<Response> => {
    const provider = c.req.param("provider")?.trim() || "codex"
    try {
      const providerConfig = await dependencies.resolveProviderConfig(
        provider,
        { signal: c.req.raw.signal },
      )
      if (!providerConfig) {
        return c.json(
          {
            error: {
              message: `Provider '${provider}' not found or disabled`,
              type: "invalid_request_error",
            },
          },
          404,
        )
      }

      dependencies.diagnostic(`images.${operation}.request`, {
        ...getContentMetadata(c.req.raw.headers),
        provider,
      })
      const dispatched = await dependencies
        .createProviderImagesPort(providerConfig)
        .dispatch({ operation, request: c.req.raw })
      dependencies.diagnostic(`images.${operation}.response`, {
        ...getContentMetadata(dispatched.response.headers),
        provider,
        statusCode: dispatched.response.status,
      })
      return dispatched.response
    } catch (error) {
      logger.error(`images.${operation}.error`, {
        errorName: error instanceof Error ? error.name : "UnknownError",
        provider,
      })
      return await forwardError(c, createContentSafeImageError(error))
    }
  }

  routes.post("/generations", (c) => handle(c, "generations"))
  routes.post("/edits", (c) => handle(c, "edits"))
  return routes
}

const getContentMetadata = (headers: Headers) => ({
  contentLength: headers.get("content-length"),
  contentType: headers.get("content-type"),
})

const createContentSafeImageError = (error: unknown): Error =>
  error instanceof AuthRequestError ? error : (
    new Error("Provider image request failed")
  )

export const imageRoutes = createImageRoutes()
