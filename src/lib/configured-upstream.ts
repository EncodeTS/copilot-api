import { getUpstreamTimeouts } from "./config"
import {
  fetchWithUpstreamLifecycle,
  type UpstreamHttpLifecycleOptions,
} from "./upstream-lifecycle"

// Keep the low-level lifecycle independent of disk configuration and capture
// one effective policy before dispatching an upstream HTTP request.
export function fetchWithConfiguredUpstreamLifecycle(
  input: Parameters<typeof fetchWithUpstreamLifecycle>[0],
  init: Parameters<typeof fetchWithUpstreamLifecycle>[1],
  options: UpstreamHttpLifecycleOptions = {},
): Promise<Response> {
  return fetchWithUpstreamLifecycle(input, init, {
    ...options,
    timeouts: getUpstreamTimeouts(options.timeouts),
  })
}
