export const RESPONSES_ENDPOINT = "/responses"
export const RESPONSES_V1_ENDPOINT = "/v1/responses"
export const RESPONSES_WS_ENDPOINT = "ws:/responses"

export interface ResponsesEndpointCapabilities {
  http: boolean
  websocket: boolean
}

export const getResponsesEndpointCapabilities = (
  model:
    | {
        supported_endpoints?: Array<string>
      }
    | undefined,
): ResponsesEndpointCapabilities => {
  const supportedEndpoints = model?.supported_endpoints ?? []
  return {
    http:
      supportedEndpoints.includes(RESPONSES_ENDPOINT)
      || supportedEndpoints.includes(RESPONSES_V1_ENDPOINT),
    websocket: supportedEndpoints.includes(RESPONSES_WS_ENDPOINT),
  }
}
