import { getGitHubApiBaseUrl, githubHeaders } from "~/lib/api-config"
import {
  AuthProtocolError,
  createAuthRequestError,
  fetchAuthJson,
  readOAuthErrorCode,
  requireAuthObject,
  type AuthRequestOptions,
} from "~/lib/auth-request"
import { state } from "~/lib/state"

export const getCopilotToken = async (options?: AuthRequestOptions) => {
  const response = await fetchAuthJson(
    `${getGitHubApiBaseUrl()}/copilot_internal/v2/token`,
    {
      headers: githubHeaders(state),
    },
    {
      ...options,
      action: "GitHub Copilot token request",
    },
  )

  const oauthCode = readOAuthErrorCode(response.payload)
  if (!response.ok || oauthCode) {
    throw createAuthRequestError({
      action: "GitHub Copilot token request",
      headers: response.headers,
      oauthCode,
      status: response.status,
    })
  }

  const payload = requireAuthObject(
    response,
    "GitHub Copilot token request",
  ) as Partial<GetCopilotTokenResponse>
  if (
    typeof payload.expires_at !== "number"
    || !Number.isFinite(payload.expires_at)
    || typeof payload.refresh_in !== "number"
    || !Number.isFinite(payload.refresh_in)
    || payload.refresh_in <= 0
    || typeof payload.token !== "string"
    || !payload.token
  ) {
    throw new AuthProtocolError(
      "GitHub Copilot token response is missing required fields",
    )
  }

  return payload as GetCopilotTokenResponse
}

// Trimmed for the sake of simplicity
export interface GetCopilotTokenResponse {
  expires_at: number
  refresh_in: number
  token: string
}
