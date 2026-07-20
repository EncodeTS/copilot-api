import { getOauthAppConfig, getOauthUrls } from "~/lib/api-config"
import {
  AuthProtocolError,
  createAuthRequestError,
  fetchAuthJson,
  readOAuthErrorCode,
  requireAuthObject,
  type AuthRequestOptions,
} from "~/lib/auth-request"

export async function getDeviceCode(
  options?: AuthRequestOptions,
): Promise<DeviceCodeResponse> {
  const { clientId, headers, scope } = getOauthAppConfig()
  const { deviceCodeUrl } = getOauthUrls()

  const response = await fetchAuthJson(
    deviceCodeUrl,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        client_id: clientId,
        scope,
      }),
    },
    {
      ...options,
      action: "GitHub device-code request",
    },
  )

  const oauthCode = readOAuthErrorCode(response.payload)
  if (!response.ok || oauthCode) {
    throw createAuthRequestError({
      action: "GitHub device-code request",
      headers: response.headers,
      oauthCode,
      status: response.status,
    })
  }

  const payload = requireAuthObject(
    response,
    "GitHub device-code request",
  ) as Partial<DeviceCodeResponse>
  const interval = payload.interval === undefined ? 5 : payload.interval
  if (
    typeof payload.device_code !== "string"
    || !payload.device_code
    || typeof payload.user_code !== "string"
    || !payload.user_code
    || typeof payload.verification_uri !== "string"
    || !payload.verification_uri
    || typeof payload.expires_in !== "number"
    || !Number.isFinite(payload.expires_in)
    || payload.expires_in <= 0
    || typeof interval !== "number"
    || !Number.isFinite(interval)
    || interval <= 0
  ) {
    throw new AuthProtocolError(
      "GitHub device-code response is missing required fields",
    )
  }

  return {
    device_code: payload.device_code,
    expires_in: payload.expires_in,
    interval,
    user_code: payload.user_code,
    verification_uri: payload.verification_uri,
  }
}

export interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number
  interval: number
}
