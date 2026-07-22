import { Hono } from "hono"

import { createHandlerLogger, logDiagnosticEvent } from "~/lib/logger"
import { resolveProviderConfig } from "~/lib/provider-resolver"
import { UpstreamLifecycleTimeoutError } from "~/lib/upstream-lifecycle"
import { createProviderAlphaSearchPort } from "~/services/providers/provider-alpha-search-port"

const logger = createHandlerLogger("alpha-search-handler")

export interface AlphaSearchRoutesComposition {
  createProviderAlphaSearchPort?: typeof createProviderAlphaSearchPort
  logDiagnosticEvent?: typeof logDiagnosticEvent
  resolveProviderConfig?: typeof resolveProviderConfig
}

export const createAlphaSearchRoutes = (
  composition: AlphaSearchRoutesComposition = {},
): Hono => {
  const dependencies = Object.freeze({
    createProviderAlphaSearchPort:
      composition.createProviderAlphaSearchPort
      ?? createProviderAlphaSearchPort,
    logDiagnosticEvent: composition.logDiagnosticEvent ?? logDiagnosticEvent,
    resolveProviderConfig:
      composition.resolveProviderConfig ?? resolveProviderConfig,
  })
  const routes = new Hono()

  routes.post("/", async (c) => {
    const provider = c.req.param("provider")?.trim() || "codex"
    try {
      const providerConfig = await dependencies.resolveProviderConfig(
        provider,
        {
          signal: c.req.raw.signal,
        },
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
      if (providerConfig.type !== "openai-responses") {
        return c.json(
          {
            error: {
              message: `Provider '${provider}' does not support the /v1/alpha/search endpoint`,
              type: "invalid_request_error",
            },
          },
          400,
        )
      }

      const body = new Uint8Array(await c.req.raw.arrayBuffer())
      const port = dependencies.createProviderAlphaSearchPort(providerConfig)
      const dispatched = await port.dispatch({
        body,
        requestHeaders: c.req.raw.headers,
        requestUrl: c.req.raw.url,
        signal: c.req.raw.signal,
      })
      dependencies.logDiagnosticEvent(
        logger,
        dispatched.status >= 500 ? "error"
        : dispatched.status >= 400 ? "warn"
        : "debug",
        "alpha_search.upstream_response",
        {
          adapter: dispatched.adapter,
          provider,
          requestBytes: body.byteLength,
          statusCode: dispatched.status,
        },
      )
      return dispatched.response
    } catch (error) {
      const failure = classifyAlphaSearchFailure(error, c.req.raw.signal)
      dependencies.logDiagnosticEvent(
        logger,
        getAlphaSearchFailureLogLevel(failure),
        "alpha_search.upstream_error",
        { failure, provider },
      )
      if (failure === "timeout") {
        return c.json(
          {
            error: {
              code: "upstream_timeout",
              message: "Alpha search upstream timed out.",
              type: "upstream_error",
            },
          },
          504,
        )
      }

      return c.json(
        {
          error: {
            code: "upstream_request_failed",
            message: "Alpha search upstream request failed.",
            type: "upstream_error",
          },
        },
        502,
      )
    }
  })

  return routes
}

export const alphaSearchRoutes = createAlphaSearchRoutes()

const classifyAlphaSearchFailure = (
  error: unknown,
  signal: AbortSignal,
): "caller_abort" | "timeout" | "transport_error" => {
  if (error instanceof UpstreamLifecycleTimeoutError) return "timeout"
  return signal.aborted ? "caller_abort" : "transport_error"
}

const getAlphaSearchFailureLogLevel = (
  failure: ReturnType<typeof classifyAlphaSearchFailure>,
): "debug" | "error" | "warn" => {
  if (failure === "caller_abort") return "debug"
  return failure === "timeout" ? "warn" : "error"
}
