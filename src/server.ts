import { Hono, type ErrorHandler } from "hono"
import { logger } from "hono/logger"
import { readFileSync } from "node:fs"

import { createQuerySafeAccessLogOutput } from "./lib/access-logger"
import {
  createNetworkSecurityMiddleware,
  createUsageViewerContentSecurityPolicy,
} from "./lib/network-security"
import {
  createAuthMiddleware,
  getConfiguredAdminApiKeys,
} from "./lib/request-auth"
import { traceIdMiddleware } from "~/lib/trace"
import {
  createRequestBodyErrorResponse,
  requestBodyMiddleware,
} from "~/lib/zstd-request"
import { alphaSearchRoutes } from "./routes/alpha-search/route"
import { completionRoutes } from "./routes/chat-completions/route"
import { configRoutes } from "./routes/admin/config/route"
import { embeddingRoutes } from "./routes/embeddings/route"
import { imageRoutes } from "./routes/images/route"
import { messageRoutes } from "./routes/messages/route"
import { modelRoutes } from "./routes/models/route"
import { providerMessageRoutes } from "./routes/provider/messages/route"
import { providerModelRoutes } from "./routes/provider/models/route"
import { providerResponsesRoutes } from "./routes/provider/responses/route"
import { responsesRoutes } from "./routes/responses/route"
import { tokenUsageRoute } from "./routes/token-usage/route"
import { usageRoute } from "./routes/usage/route"

export const server = new Hono()
const usageViewerFileUrl = new URL("../pages/index.html", import.meta.url)
const usageViewerHtml = readFileSync(usageViewerFileUrl, "utf8")
const usageViewerCssFileUrl = new URL(
  "../pages/usage-viewer.css",
  import.meta.url,
)
const usageViewerCss = readFileSync(usageViewerCssFileUrl, "utf8")
const usageViewerContentSecurityPolicy =
  createUsageViewerContentSecurityPolicy(usageViewerHtml)

export const serverErrorHandler: ErrorHandler = (error, c) => {
  const requestBodyErrorResponse = createRequestBodyErrorResponse(c, error)
  if (requestBodyErrorResponse !== null) {
    return requestBodyErrorResponse
  }

  console.error(error)
  return c.text("Internal Server Error", 500)
}

server.onError(serverErrorHandler)

server.use("*", createNetworkSecurityMiddleware())
server.use(traceIdMiddleware)
server.use(logger(createQuerySafeAccessLogOutput()))
server.use(
  "*",
  createAuthMiddleware({
    allowUnauthenticatedPaths: [
      "/",
      "/usage-viewer",
      "/usage-viewer/",
      "/usage-viewer.css",
    ],
    shouldSkipPath: (path) => path.startsWith("/admin/"),
  }),
)
server.use(
  "/admin/*",
  createAuthMiddleware({
    getApiKeys: getConfiguredAdminApiKeys,
    allowUnauthenticatedPaths: [],
    allowWhenNoApiKeys: false,
  }),
)
server.use(requestBodyMiddleware)

server.get("/", (c) => c.text("Server running"))
server.get("/usage-viewer", (c) => {
  c.header("Content-Security-Policy", usageViewerContentSecurityPolicy)
  return c.html(usageViewerHtml)
})
server.get("/usage-viewer.css", (c) => {
  c.header("Cache-Control", "public, max-age=86400")
  c.header("Content-Type", "text/css; charset=UTF-8")
  return c.body(usageViewerCss)
})
server.get("/usage-viewer/", (c) => c.redirect("/usage-viewer", 301))

server.route("/chat/completions", completionRoutes)
server.route("/admin/config", configRoutes)
server.route("/models", modelRoutes)
server.route("/embeddings", embeddingRoutes)
server.route("/usage", usageRoute)
server.route("/token-usage", tokenUsageRoute)
server.route("/responses", responsesRoutes)
server.route("/alpha/search", alphaSearchRoutes)
server.route("/images", imageRoutes)

// Compatibility with tools that expect v1/ prefix
server.route("/v1/chat/completions", completionRoutes)
server.route("/v1/models", modelRoutes)
server.route("/v1/embeddings", embeddingRoutes)
server.route("/v1/responses", responsesRoutes)
server.route("/v1/alpha/search", alphaSearchRoutes)
server.route("/v1/images", imageRoutes)

// Anthropic compatible endpoints
server.route("/v1/messages", messageRoutes)

// Provider-scoped endpoints
server.route("/:provider/v1/alpha/search", alphaSearchRoutes)
server.route("/:provider/v1/images", imageRoutes)
server.route("/:provider/v1/messages", providerMessageRoutes)
server.route("/:provider/v1/models", providerModelRoutes)
server.route("/:provider/v1/responses", providerResponsesRoutes)
