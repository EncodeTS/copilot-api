export interface ResponsesWebSocketResourceLimits {
  capacityWaitMs: number
  dedicatedConnectionLimit: number
  globalConnectionLimit: number
  idleConnectionLimit: number
  idleTimeoutMs: number
  maxFrameBytes: number
  maxQueuedBytes: number
  maxQueuedFrames: number
  perCapacityKeyConnectionLimit: number
}

export const DEFAULT_RESPONSES_WEBSOCKET_RESOURCE_LIMITS = {
  capacityWaitMs: 250,
  dedicatedConnectionLimit: 64,
  globalConnectionLimit: 128,
  idleConnectionLimit: 32,
  idleTimeoutMs: 60_000,
  maxFrameBytes: 32 * 1_048_576,
  maxQueuedBytes: 64 * 1_048_576,
  maxQueuedFrames: 4096,
  perCapacityKeyConnectionLimit: 32,
} as const satisfies ResponsesWebSocketResourceLimits
