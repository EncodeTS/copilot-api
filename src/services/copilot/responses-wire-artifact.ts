import type { ResponsesPayload } from "~/services/copilot/create-responses"
import { deepFreeze } from "~/lib/deep-freeze"
import {
  responsesReasoningRecoveryRegistry,
  type ReasoningRecoveryScope,
} from "~/services/copilot/responses-reasoning-recovery-registry"

const ENCRYPTED_REASONING_INCLUDE = "reasoning.encrypted_content"
const MAX_RESPONSES_TOOL_GRAPH_ENTRIES = 10_000
const responsesPayloadSerializationBrand = Symbol(
  "responsesPayloadSerialization",
)
const immutableResponsesPayloadSerializationBrand = Symbol(
  "immutableResponsesPayloadSerialization",
)
const responsesWireSerializationBrand = Symbol("responsesWireSerialization")
const responsesWireArtifactBrand = Symbol("responsesWireArtifact")

interface ResponsesPayloadSerializationRecord {
  immutable: boolean
  payloadBytes: number
  serializedPayload: string
  sourcePayload: ResponsesPayload
}

interface ResponsesWireSerializationRecord {
  initiator: "agent" | "user"
  payload: ResponsesPayload
  payloadSerialization: ResponsesPayloadSerialization
  serializedPayload: string
  summary: ResponsesWireSummary
  websocketFrame: string
}

const responsesPayloadSerializations = new WeakMap<
  object,
  ResponsesPayloadSerializationRecord
>()
const responsesWireSerializations = new WeakMap<
  object,
  ResponsesWireSerializationRecord
>()
const responsesWireArtifacts = new WeakSet<object>()

export type ResponsesWireSerializationStage =
  | "budget_initial"
  | "budget_mutation"
  | "http_body"
  | "recovery_http_body"
  | "websocket_frame"

export interface ResponsesWireSerializationObserver {
  onSerialization: (stage: ResponsesWireSerializationStage) => void
}

export interface ResponsesPayloadSerializationOptions {
  observer?: ResponsesWireSerializationObserver
  stage?: Exclude<ResponsesWireSerializationStage, "websocket_frame">
}

export interface ResponsesPayloadSerialization {
  readonly payloadBytes: number
  readonly serializedPayload: string
  readonly sourcePayload: ResponsesPayload
  readonly [responsesPayloadSerializationBrand]: true
}

export interface ImmutableResponsesPayloadSerialization
  extends ResponsesPayloadSerialization {
  readonly [immutableResponsesPayloadSerializationBrand]: true
}

export interface ResponsesWireSummary {
  readonly httpBodyBytes: number
  readonly initiator: "agent" | "user"
  readonly transport: "http" | "websocket"
  readonly websocketFrameDeltaBytes?: number
  readonly websocketFrameBytes?: number
}

export interface ResponsesWireSerialization {
  readonly initiator: "agent" | "user"
  readonly payload: ResponsesPayload
  readonly payloadSerialization: ResponsesPayloadSerialization
  readonly serializedPayload: string
  readonly summary: ResponsesWireSummary
  readonly websocketFrame: string
  readonly [responsesWireSerializationBrand]: true
}

export interface ResponsesWireArtifact {
  readonly httpBody: string
  readonly payload: ResponsesPayload
  readonly serializedPayload: string
  readonly summary: ResponsesWireSummary
  readonly transport: "http" | "websocket"
  readonly websocketFrame?: string
  readonly [responsesWireArtifactBrand]: true
}

export interface PreparedResponsesWirePayload {
  readonly payload: ResponsesPayload
  readonly removedReasoningItems: number
}

export interface PrepareResponsesWirePayloadOptions {
  readonly reasoningRecoveryScope?: ReasoningRecoveryScope | null
}

export const prepareResponsesWirePayload = (
  payload: ResponsesPayload,
  options: PrepareResponsesWirePayloadOptions = {},
): ResponsesPayload =>
  prepareResponsesWirePayloadWithSummary(payload, options).payload

export const prepareResponsesWirePayloadWithSummary = (
  payload: ResponsesPayload,
  options: PrepareResponsesWirePayloadOptions = {},
): PreparedResponsesWirePayload => {
  const knownReasoning =
    options.reasoningRecoveryScope === undefined ?
      { input: payload.input, removedCount: 0 }
    : responsesReasoningRecoveryRegistry.filterKnown(
        options.reasoningRecoveryScope,
        payload.input,
      )
  const logicalPayload =
    knownReasoning.removedCount > 0 ?
      { ...payload, input: knownReasoning.input }
    : payload
  visitResponsesToolGraph(logicalPayload)
  const outboundPayload = structuredClone(logicalPayload)
  delete outboundPayload.service_tier
  normalizeResponsesToolSchemas(outboundPayload)
  ensureEncryptedReasoningIncluded(outboundPayload)
  return {
    payload: outboundPayload,
    removedReasoningItems: knownReasoning.removedCount,
  }
}

export const createResponsesWireArtifact = (
  payloadSerialization: ResponsesPayloadSerialization,
  initiator: "agent" | "user",
  transport: "http" | "websocket",
  wireSerialization?: ResponsesWireSerialization,
): ResponsesWireArtifact => {
  const payloadSerializationRecord =
    getResponsesPayloadSerializationRecord(payloadSerialization)
  const wireSerializationRecord =
    wireSerialization ?
      getResponsesWireSerializationRecord(wireSerialization)
    : undefined
  if (
    wireSerializationRecord
    && (wireSerializationRecord.payloadSerialization !== payloadSerialization
      || wireSerializationRecord.initiator !== initiator)
  ) {
    throw new TypeError(
      "Responses wire serialization does not match the admitted payload",
    )
  }

  if (transport === "http") {
    if (wireSerialization) {
      throw new TypeError(
        "HTTP Responses artifact cannot accept a websocket serialization",
      )
    }
    const payload = parseSerializedResponsesPayload(
      payloadSerializationRecord.serializedPayload,
    )
    return createWireArtifactRecord(
      payload,
      payloadSerializationRecord,
      initiator,
    )
  }

  const finalWireSerialization =
    wireSerialization
    ?? serializeResponsesWirePayload(payloadSerialization, initiator)
  return createWireArtifactRecord(
    getResponsesWireSerializationRecord(finalWireSerialization).payload,
    payloadSerializationRecord,
    initiator,
    finalWireSerialization,
  )
}

export const serializeResponsesPayload = (
  payload: ResponsesPayload,
  options: ResponsesPayloadSerializationOptions = {},
): ResponsesPayloadSerialization =>
  createResponsesPayloadSerialization(payload, options, false)

export const serializeImmutableResponsesPayload = (
  payload: ResponsesPayload,
  options: ResponsesPayloadSerializationOptions = {},
): ImmutableResponsesPayloadSerialization =>
  createResponsesPayloadSerialization(
    deepFreeze(payload),
    options,
    true,
  ) as ImmutableResponsesPayloadSerialization

const createResponsesPayloadSerialization = (
  payload: ResponsesPayload,
  options: ResponsesPayloadSerializationOptions,
  immutable: boolean,
): ResponsesPayloadSerialization | ImmutableResponsesPayloadSerialization => {
  const serializedPayload = JSON.stringify(payload)
  options.observer?.onSerialization(options.stage ?? "http_body")
  const payloadBytes = Buffer.byteLength(serializedPayload, "utf8")
  const properties: PropertyDescriptorMap = {
    [responsesPayloadSerializationBrand]: {
      value: true,
    },
    sourcePayload: {
      enumerable: false,
      value: payload,
    },
    serializedPayload: {
      enumerable: false,
      value: serializedPayload,
    },
  }
  if (immutable) {
    properties[immutableResponsesPayloadSerializationBrand] = {
      value: true,
    }
  }
  const serialization = Object.defineProperties(
    { payloadBytes } as ResponsesPayloadSerialization,
    properties,
  )
  responsesPayloadSerializations.set(serialization, {
    immutable,
    payloadBytes,
    serializedPayload,
    sourcePayload: payload,
  })
  return Object.freeze(serialization)
}

export const isResponsesWireArtifact = (
  value: unknown,
): value is ResponsesWireArtifact =>
  typeof value === "object"
  && value !== null
  && responsesWireArtifacts.has(value)

export const isImmutableResponsesPayloadSerialization = (
  value: unknown,
): value is ImmutableResponsesPayloadSerialization =>
  typeof value === "object"
  && value !== null
  && responsesPayloadSerializations.get(value)?.immutable === true

export const getResponsesPayloadSerializationSource = (
  serialization: ResponsesPayloadSerialization,
): ResponsesPayload =>
  getResponsesPayloadSerializationRecord(serialization).sourcePayload

export const serializeResponsesWirePayload = (
  payloadSerialization: ResponsesPayloadSerialization,
  initiator: "agent" | "user",
  observer?: ResponsesWireSerializationObserver,
): ResponsesWireSerialization => {
  const payloadSerializationRecord =
    getResponsesPayloadSerializationRecord(payloadSerialization)
  const payload = parseSerializedResponsesPayload(
    payloadSerializationRecord.serializedPayload,
  )
  const websocketFrame = JSON.stringify(
    buildResponsesWebSocketPayload(payload, initiator),
  )
  observer?.onSerialization("websocket_frame")
  const websocketFrameBytes = Buffer.byteLength(websocketFrame, "utf8")
  const summary = Object.freeze({
    httpBodyBytes: payloadSerializationRecord.payloadBytes,
    initiator,
    transport: "websocket" as const,
    websocketFrameDeltaBytes:
      websocketFrameBytes - payloadSerializationRecord.payloadBytes,
    websocketFrameBytes,
  })

  const serialization = Object.defineProperties(
    {
      initiator,
      summary,
    } as ResponsesWireSerialization,
    {
      [responsesWireSerializationBrand]: {
        value: true,
      },
      payloadSerialization: {
        enumerable: false,
        value: payloadSerialization,
      },
      payload: {
        enumerable: false,
        value: payload,
      },
      serializedPayload: {
        enumerable: false,
        value: payloadSerializationRecord.serializedPayload,
      },
      websocketFrame: {
        enumerable: false,
        value: websocketFrame,
      },
    },
  )
  responsesWireSerializations.set(serialization, {
    initiator,
    payload,
    payloadSerialization,
    serializedPayload: payloadSerializationRecord.serializedPayload,
    summary,
    websocketFrame,
  })
  return Object.freeze(serialization)
}

export const admitResponsesWirePayload = (
  payload: ResponsesPayload,
  initiator: "agent" | "user",
  transport: "http" | "websocket",
  options: {
    observer?: ResponsesWireSerializationObserver
    payloadStage?: Exclude<ResponsesWireSerializationStage, "websocket_frame">
  } = {},
): ResponsesWireArtifact => {
  const payloadSerialization = serializeResponsesPayload(payload, {
    observer: options.observer,
    stage: options.payloadStage,
  })
  const wireSerialization =
    transport === "websocket" ?
      serializeResponsesWirePayload(
        payloadSerialization,
        initiator,
        options.observer,
      )
    : undefined
  return createResponsesWireArtifact(
    payloadSerialization,
    initiator,
    transport,
    wireSerialization,
  )
}

const createWireArtifactRecord = (
  payload: ResponsesPayload,
  payloadSerialization: ResponsesPayloadSerializationRecord,
  initiator: "agent" | "user",
  wireSerialization?: ResponsesWireSerialization,
): ResponsesWireArtifact => {
  const serializedPayload = payloadSerialization.serializedPayload
  const wireSerializationRecord =
    wireSerialization ?
      getResponsesWireSerializationRecord(wireSerialization)
    : undefined
  const summary =
    wireSerializationRecord?.summary
    ?? Object.freeze({
      httpBodyBytes: payloadSerialization.payloadBytes,
      initiator,
      transport: "http" as const,
    })
  const artifact = Object.defineProperties(
    { summary } as ResponsesWireArtifact,
    {
      httpBody: {
        enumerable: false,
        value: serializedPayload,
      },
      payload: {
        enumerable: false,
        value: payload,
      },
      serializedPayload: {
        enumerable: false,
        value: serializedPayload,
      },
      transport: {
        enumerable: false,
        value: summary.transport,
      },
      [responsesWireArtifactBrand]: {
        value: true,
      },
      ...(wireSerializationRecord ?
        {
          websocketFrame: {
            enumerable: false,
            value: wireSerializationRecord.websocketFrame,
          },
        }
      : {}),
    },
  )
  responsesWireArtifacts.add(artifact)
  return Object.freeze(artifact)
}

const parseSerializedResponsesPayload = (
  serializedPayload: string,
): ResponsesPayload =>
  deepFreeze(JSON.parse(serializedPayload) as ResponsesPayload)

const getResponsesPayloadSerializationRecord = (
  serialization: ResponsesPayloadSerialization,
): ResponsesPayloadSerializationRecord => {
  if (typeof serialization !== "object" || serialization === null) {
    throw new TypeError("Invalid Responses payload serialization")
  }
  const record = responsesPayloadSerializations.get(serialization)
  if (!record) {
    throw new TypeError("Invalid Responses payload serialization")
  }
  return record
}

const getResponsesWireSerializationRecord = (
  serialization: ResponsesWireSerialization,
): ResponsesWireSerializationRecord => {
  if (typeof serialization !== "object" || serialization === null) {
    throw new TypeError("Invalid Responses wire serialization")
  }
  const record = responsesWireSerializations.get(serialization)
  if (!record) {
    throw new TypeError("Invalid Responses wire serialization")
  }
  return record
}

export const buildResponsesWebSocketPayload = (
  payload: ResponsesPayload,
  initiator: "agent" | "user",
): ResponsesPayload & {
  initiator: "agent" | "user"
  type: "response.create"
} => {
  const websocketPayload: ResponsesPayload & {
    initiator: "agent" | "user"
    type: "response.create"
  } = {
    ...payload,
    type: "response.create",
    initiator,
  }

  delete websocketPayload.stream
  delete websocketPayload.background
  delete websocketPayload.service_tier

  return websocketPayload
}

export const ensureEncryptedReasoningIncluded = (
  payload: ResponsesPayload,
): void => {
  const include = Array.isArray(payload.include) ? payload.include : []
  if (include.includes(ENCRYPTED_REASONING_INCLUDE)) {
    return
  }

  payload.include = [...include, ENCRYPTED_REASONING_INCLUDE]
}

export const normalizeResponsesToolSchemas = (
  payload: ResponsesPayload,
): void => {
  visitResponsesToolGraph(payload, (tool) => {
    const parameters = tool.parameters
    if (
      tool.type === "function"
      && isRecord(parameters)
      && typeof parameters.type === "string"
      && parameters.type.trim().toLowerCase() === "none"
    ) {
      tool.parameters = {
        properties: {},
        type: "object",
      }
    }
  })
}

const visitResponsesToolGraph = (
  payload: ResponsesPayload,
  visitor: (tool: Record<string, unknown>) => void = () => {},
): void => {
  const pending = collectResponsesToolGroups(payload)
  let visitedEntries = 0

  while (pending.length > 0) {
    const tools = pending.pop()
    if (!tools) continue
    for (const tool of tools) {
      visitedEntries += 1
      if (visitedEntries > MAX_RESPONSES_TOOL_GRAPH_ENTRIES) {
        throw new RangeError("Responses tool graph exceeds 10000 entries")
      }
      if (!isRecord(tool)) continue
      visitor(tool)
      if (tool.type === "namespace" && Array.isArray(tool.tools)) {
        pending.push(tool.tools)
      }
    }
  }
}

const collectResponsesToolGroups = (
  payload: ResponsesPayload,
): Array<Array<unknown>> => {
  const groups: Array<Array<unknown>> = []
  if (Array.isArray(payload.tools)) groups.push(payload.tools)
  if (Array.isArray(payload.input)) {
    for (const item of payload.input) {
      if (isRecord(item) && Array.isArray(item.tools)) {
        groups.push(item.tools)
      }
    }
  }
  return groups
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
