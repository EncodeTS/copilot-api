export interface ProviderBaseUrlPolicyOptions {
  allowInsecureHttp?: boolean
}

export class ProviderBaseUrlPolicyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ProviderBaseUrlPolicyError"
  }
}

const isLoopbackHostname = (hostname: string): boolean => {
  const normalized = hostname.replace(/^\[|\]$/gu, "").toLowerCase()
  if (normalized === "::1") return true
  if (normalized === "localhost" || normalized.endsWith(".localhost")) {
    return true
  }

  const ipv4Parts = normalized.split(".")
  return (
    ipv4Parts.length === 4
    && ipv4Parts.every((part) => /^\d{1,3}$/u.test(part))
    && Number(ipv4Parts[0]) === 127
    && ipv4Parts.every((part) => Number(part) <= 255)
  )
}

export const validateProviderBaseUrl = (
  value: string,
  options: ProviderBaseUrlPolicyOptions = {},
): string => {
  const normalized = value.trim().replace(/\/+$/u, "")
  if (!normalized) {
    throw new ProviderBaseUrlPolicyError(
      "Provider baseUrl must be a non-empty HTTPS URL",
    )
  }

  let url: URL
  try {
    url = new URL(normalized)
  } catch {
    throw new ProviderBaseUrlPolicyError(
      "Provider baseUrl must be a valid absolute HTTPS URL",
    )
  }

  if (url.protocol === "https:") return normalized
  if (
    url.protocol === "http:"
    && (isLoopbackHostname(url.hostname) || options.allowInsecureHttp === true)
  ) {
    return normalized
  }

  if (url.protocol === "http:") {
    throw new ProviderBaseUrlPolicyError(
      "Provider baseUrl must use HTTPS unless it targets loopback or allowInsecureHttp is explicitly enabled",
    )
  }

  throw new ProviderBaseUrlPolicyError(
    "Provider baseUrl must use the HTTPS or HTTP protocol",
  )
}
