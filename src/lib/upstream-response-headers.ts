// Response metadata only. Never copy authentication, cookies, transport framing,
// or upstream security policies onto the gateway's own response.
const FORWARDED_HEADERS = new Set([
  "retry-after",
  "request-id",
  "x-request-id",
  "x-github-request-id",
  "x-github-backend",
  "openai-processing-ms",
])

export const getUpstreamResponseMetadataHeaders = (
  headers: Headers,
): Record<string, string> => {
  const metadata: Record<string, string> = {}
  for (const [name, value] of headers) {
    if (FORWARDED_HEADERS.has(name) || name.startsWith("x-ratelimit-")) {
      metadata[name] = value
    }
  }
  return metadata
}
