import { getGitHubApiBaseUrl, githubUserHeaders } from "~/lib/api-config"
import {
  AuthProtocolError,
  createAuthRequestError,
  fetchAuthJson,
  requireAuthObject,
  type AuthRequestOptions,
} from "~/lib/auth-request"
import { state } from "~/lib/state"

export async function getGitHubUser(
  githubToken?: string,
  options?: AuthRequestOptions,
) {
  const resolvedGithubToken = githubToken ?? state.githubToken
  if (!resolvedGithubToken) {
    throw new Error("GitHub token not found")
  }

  const authState = { ...state, githubToken: resolvedGithubToken }
  const response = await fetchAuthJson(
    `${getGitHubApiBaseUrl()}/user`,
    {
      headers: githubUserHeaders(authState),
    },
    {
      ...options,
      action: "GitHub user request",
    },
  )

  if (!response.ok) {
    throw createAuthRequestError({
      action: "GitHub user request",
      headers: response.headers,
      status: response.status,
    })
  }

  const payload = requireAuthObject(response, "GitHub user request")
  if (typeof payload.login !== "string" || !payload.login) {
    throw new AuthProtocolError(
      "GitHub user response is missing required fields",
    )
  }
  return payload as unknown as GithubUserResponse
}

// Trimmed for the sake of simplicity
interface GithubUserResponse {
  login: string
}
