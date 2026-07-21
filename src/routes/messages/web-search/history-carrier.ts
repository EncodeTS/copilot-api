export const WEB_SEARCH_HISTORY_CARRIER_FIELD =
  "_copilot_api_web_search_history"
export const WEB_SEARCH_HISTORY_CARRIER_PREFIX = "copilot-api-web-search-v1:"
export const WEB_SEARCH_HISTORY_MAX_DECODED_BYTES = 4 * 1024 * 1024
export const WEB_SEARCH_HISTORY_MAX_COLLECTION_WIDTH = 10_000
export const WEB_SEARCH_HISTORY_MAX_TOTAL_NODES = 100_000
export const WEB_SEARCH_HISTORY_MAX_ENCODED_CHARS = Math.ceil(
  (WEB_SEARCH_HISTORY_MAX_DECODED_BYTES * 4) / 3,
)
export const WEB_SEARCH_HISTORY_MAX_OUTPUT_ITEMS = 256

const WEB_SEARCH_HISTORY_SCHEMA = "copilot-api.web-search-history" as const
const WEB_SEARCH_HISTORY_NUMERIC_VERSION_PATTERN =
  /^copilot-api-web-search-v(?:0|[1-9]\d*):/u
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true })
const CARRIER_PAYLOAD_FIELDS = [
  "continuation",
  "output_items",
  "source",
] as const
const CARRIER_ENVELOPE_FIELDS = [
  ...CARRIER_PAYLOAD_FIELDS,
  "schema",
  "version",
] as const
const CARRIER_SOURCE_FIELDS = [
  "adapter",
  "destination",
  "model",
  "provider",
] as const

export type WebSearchHistoryDestination =
  | "chat_completions"
  | "messages"
  | "responses"

export type WebSearchHistoryResponsesAdapter =
  | "copilot-responses"
  | "provider-responses"

export type WebSearchHistoryTargetAdapter =
  | "anthropic-messages"
  | "chat-completions"
  | WebSearchHistoryResponsesAdapter

export interface WebSearchHistoryCanonicalTarget {
  readonly adapter: WebSearchHistoryTargetAdapter
  readonly provider: string
  readonly model: string
}

export interface WebSearchHistoryCarrierSource
  extends WebSearchHistoryCanonicalTarget {
  readonly adapter: WebSearchHistoryResponsesAdapter
  readonly destination: "responses"
}

export interface WebSearchHistoryDecodeContext {
  readonly destination: WebSearchHistoryDestination
  readonly canonicalTarget: WebSearchHistoryCanonicalTarget
}

export type WebSearchHistoryContinuation =
  | { readonly kind: "complete" }
  | {
      readonly kind: "pause_turn"
      readonly pending_server_tool_use_ids: ReadonlyArray<string>
    }
  | {
      readonly kind: "waiting_client_tools"
      readonly pending_server_tool_use_ids: ReadonlyArray<string>
      readonly pending_client_tool_use_ids: ReadonlyArray<string>
    }

export interface WebSearchHistoryCarrierPayload {
  readonly source: WebSearchHistoryCarrierSource
  readonly output_items: ReadonlyArray<unknown>
  readonly continuation: WebSearchHistoryContinuation
}

export type WebSearchHistoryOutputItem = Readonly<Record<string, unknown>>

export interface WebSearchHistoryCarrierEnvelopeV1
  extends WebSearchHistoryCarrierPayload {
  readonly schema: typeof WEB_SEARCH_HISTORY_SCHEMA
  readonly version: 1
  readonly output_items: ReadonlyArray<WebSearchHistoryOutputItem>
}

export type WebSearchHistoryCarrierValidationResult =
  | { valid: true }
  | {
      valid: false
      reason:
        | "invalid-continuation"
        | "invalid-envelope"
        | "invalid-output-items"
        | "invalid-source"
        | "missing-web-search-call"
        | "too-large"
    }

export class WebSearchHistoryCarrierValidationError extends Error {
  readonly reason: Exclude<
    WebSearchHistoryCarrierValidationResult,
    { valid: true }
  >["reason"]

  constructor(reason: WebSearchHistoryCarrierValidationError["reason"]) {
    super(`Invalid Web Search history carrier payload: ${reason}`)
    this.name = "WebSearchHistoryCarrierValidationError"
    this.reason = reason
  }
}

export type WebSearchHistoryCarrierDecodeResult =
  | {
      kind: "accepted"
      envelope: WebSearchHistoryCarrierEnvelopeV1
    }
  | {
      kind: "legacy"
      mode: "non-resumable"
    }
  | {
      kind: "rejected"
      reason:
        | "adapter-mismatch"
        | "destination-mismatch"
        | "malformed"
        | "model-mismatch"
        | "provider-mismatch"
        | "too-large"
        | "unsupported-version"
    }

export type WebSearchHistoryCarrierLogFields =
  | {
      carrierStatus: "accepted"
      carrierVersion: 1
      continuationKind: WebSearchHistoryContinuation["kind"]
      outputItemCount: number
    }
  | {
      carrierStatus: "legacy"
      mode: "non-resumable"
    }
  | {
      carrierStatus: "rejected"
      reason: Extract<
        WebSearchHistoryCarrierDecodeResult,
        { kind: "rejected" }
      >["reason"]
    }

type PreparedWebSearchHistoryCarrier =
  | {
      valid: true
      envelope: WebSearchHistoryCarrierEnvelopeV1
      serialized: string
    }
  | {
      valid: false
      validation: Exclude<
        WebSearchHistoryCarrierValidationResult,
        { valid: true }
      >
    }

export const encodeWebSearchHistoryCarrier = (
  payload: WebSearchHistoryCarrierPayload,
): string => {
  const prepared = prepareWebSearchHistoryCarrier(payload)
  if (!prepared.valid) {
    throw new WebSearchHistoryCarrierValidationError(prepared.validation.reason)
  }
  const encoded = Buffer.from(prepared.serialized, "utf8").toString("base64url")
  if (encoded.length > WEB_SEARCH_HISTORY_MAX_ENCODED_CHARS) {
    throw new WebSearchHistoryCarrierValidationError("too-large")
  }
  return WEB_SEARCH_HISTORY_CARRIER_PREFIX + encoded
}

export const validateWebSearchHistoryCarrierPayload = (
  payload: unknown,
): WebSearchHistoryCarrierValidationResult => {
  const prepared = prepareWebSearchHistoryCarrier(payload)
  return prepared.valid ? { valid: true } : prepared.validation
}

const validateCanonicalCarrierPayload = (
  payload: unknown,
): WebSearchHistoryCarrierValidationResult => {
  if (!isRecord(payload)) {
    return { valid: false, reason: "invalid-source" }
  }
  const fields =
    Object.hasOwn(payload, "schema") || Object.hasOwn(payload, "version") ?
      CARRIER_ENVELOPE_FIELDS
    : CARRIER_PAYLOAD_FIELDS
  if (!hasExactFields(payload, fields)) {
    return { valid: false, reason: "invalid-envelope" }
  }
  if (
    fields === CARRIER_ENVELOPE_FIELDS
    && (payload.schema !== WEB_SEARCH_HISTORY_SCHEMA || payload.version !== 1)
  ) {
    return { valid: false, reason: "invalid-envelope" }
  }
  if (!isCarrierSource(payload.source)) {
    return { valid: false, reason: "invalid-source" }
  }
  if (
    !Array.isArray(payload.output_items)
    || payload.output_items.length === 0
    || payload.output_items.length > WEB_SEARCH_HISTORY_MAX_OUTPUT_ITEMS
  ) {
    return {
      valid: false,
      reason:
        (
          Array.isArray(payload.output_items)
          && payload.output_items.length > WEB_SEARCH_HISTORY_MAX_OUTPUT_ITEMS
        ) ?
          "too-large"
        : "invalid-output-items",
    }
  }
  if (
    !payload.output_items.every(isRecord)
    || !payload.output_items.every(isOutputItemContract)
  ) {
    return { valid: false, reason: "invalid-output-items" }
  }
  const outputItems = payload.output_items
  const webSearchCalls = outputItems.filter(
    (item) => item.type === "web_search_call",
  )
  if (webSearchCalls.length === 0) {
    return { valid: false, reason: "missing-web-search-call" }
  }
  const itemIds = new Set<string>()
  for (const item of outputItems) {
    if (item.id === undefined) continue
    if (!isStableId(item.id) || itemIds.has(item.id)) {
      return { valid: false, reason: "invalid-output-items" }
    }
    itemIds.add(item.id)
  }
  if (webSearchCalls.some((item) => !isStableId(item.id))) {
    return { valid: false, reason: "invalid-output-items" }
  }
  if (!isContinuation(payload.continuation)) {
    return { valid: false, reason: "invalid-continuation" }
  }
  return { valid: true }
}

const prepareWebSearchHistoryCarrier = (
  input: unknown,
): PreparedWebSearchHistoryCarrier => {
  const canonical = canonicalizeJsonValue(input)
  if (!canonical.valid) {
    return {
      valid: false,
      validation: {
        valid: false,
        reason: classifyCanonicalFailure(canonical),
      },
    }
  }
  const canonicalRecord = isRecord(canonical.value) ? canonical.value : null
  const isEnvelopeForm =
    canonicalRecord !== null
    && Object.hasOwn(canonicalRecord, "schema")
    && Object.hasOwn(canonicalRecord, "version")
  const envelopeNodeCount = canonical.nodeCount + (isEnvelopeForm ? 0 : 2)
  if (envelopeNodeCount > WEB_SEARCH_HISTORY_MAX_TOTAL_NODES) {
    return {
      valid: false,
      validation: { valid: false, reason: "too-large" },
    }
  }
  const validation = validateCanonicalCarrierPayload(canonical.value)
  if (!validation.valid) {
    return { valid: false, validation }
  }
  const payload = canonical.value as Record<string, unknown>
  const envelope: WebSearchHistoryCarrierEnvelopeV1 = {
    schema: WEB_SEARCH_HISTORY_SCHEMA,
    version: 1,
    source: payload.source as WebSearchHistoryCarrierSource,
    output_items:
      payload.output_items as ReadonlyArray<WebSearchHistoryOutputItem>,
    continuation: payload.continuation as WebSearchHistoryContinuation,
  }
  const serialized = JSON.stringify(envelope)
  if (
    Buffer.byteLength(serialized, "utf8") > WEB_SEARCH_HISTORY_MAX_DECODED_BYTES
  ) {
    return {
      valid: false,
      validation: { valid: false, reason: "too-large" },
    }
  }
  return { valid: true, envelope, serialized }
}

const classifyCanonicalFailure = (
  failure: Exclude<CanonicalJsonResult, { valid: true }>,
): Exclude<
  WebSearchHistoryCarrierValidationResult,
  { valid: true }
>["reason"] => {
  if (failure.reason === "too-large") return "too-large"
  switch (failure.topLevelField) {
    case "continuation":
      return "invalid-continuation"
    case "output_items":
      return "invalid-output-items"
    case "source":
      return "invalid-source"
    default:
      return "invalid-envelope"
  }
}

export const decodeWebSearchHistoryCarrier = (
  carrier: unknown,
  context: WebSearchHistoryDecodeContext,
): WebSearchHistoryCarrierDecodeResult => {
  if (carrier === undefined) {
    return { kind: "legacy", mode: "non-resumable" }
  }
  if (context.destination !== "responses") {
    return { kind: "rejected", reason: "destination-mismatch" }
  }
  if (typeof carrier !== "string") {
    return { kind: "rejected", reason: "malformed" }
  }
  if (!carrier.startsWith(WEB_SEARCH_HISTORY_CARRIER_PREFIX)) {
    return {
      kind: "rejected",
      reason:
        WEB_SEARCH_HISTORY_NUMERIC_VERSION_PATTERN.test(carrier) ?
          "unsupported-version"
        : "malformed",
    }
  }

  const encoded = carrier.slice(WEB_SEARCH_HISTORY_CARRIER_PREFIX.length)
  if (encoded.length > WEB_SEARCH_HISTORY_MAX_ENCODED_CHARS) {
    return { kind: "rejected", reason: "too-large" }
  }
  if (!BASE64URL_PATTERN.test(encoded)) {
    return { kind: "rejected", reason: "malformed" }
  }

  try {
    const decoded = Buffer.from(encoded, "base64url")
    if (decoded.byteLength > WEB_SEARCH_HISTORY_MAX_DECODED_BYTES) {
      return { kind: "rejected", reason: "too-large" }
    }
    if (decoded.toString("base64url") !== encoded) {
      return { kind: "rejected", reason: "malformed" }
    }
    const value: unknown = JSON.parse(UTF8_DECODER.decode(decoded))
    if (
      !isRecord(value)
      || value.schema !== WEB_SEARCH_HISTORY_SCHEMA
      || value.version !== 1
    ) {
      return { kind: "rejected", reason: "malformed" }
    }
    const prepared = prepareWebSearchHistoryCarrier(value)
    if (!prepared.valid) {
      return {
        kind: "rejected",
        reason:
          prepared.validation.reason === "too-large" ?
            "too-large"
          : "malformed",
      }
    }
    const { envelope } = prepared
    if (envelope.source.adapter !== context.canonicalTarget.adapter) {
      return { kind: "rejected", reason: "adapter-mismatch" }
    }
    if (envelope.source.provider !== context.canonicalTarget.provider) {
      return { kind: "rejected", reason: "provider-mismatch" }
    }
    if (envelope.source.model !== context.canonicalTarget.model) {
      return { kind: "rejected", reason: "model-mismatch" }
    }
    deepFreezeJson(envelope)
    return {
      kind: "accepted",
      envelope,
    }
  } catch {
    return { kind: "rejected", reason: "malformed" }
  }
}

export const getWebSearchHistoryCarrierLogFields = (
  result: WebSearchHistoryCarrierDecodeResult,
): WebSearchHistoryCarrierLogFields => {
  if (result.kind === "accepted") {
    return {
      carrierStatus: "accepted",
      carrierVersion: result.envelope.version,
      continuationKind: result.envelope.continuation.kind,
      outputItemCount: result.envelope.output_items.length,
    }
  }
  if (result.kind === "legacy") {
    return { carrierStatus: "legacy", mode: result.mode }
  }
  return { carrierStatus: "rejected", reason: result.reason }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isCarrierSource = (
  value: unknown,
): value is WebSearchHistoryCarrierSource =>
  isRecord(value)
  && hasExactFields(value, CARRIER_SOURCE_FIELDS)
  && value.destination === "responses"
  && (value.adapter === "copilot-responses"
    || value.adapter === "provider-responses")
  && typeof value.provider === "string"
  && value.provider.length > 0
  && value.provider.length <= 256
  && value.provider === value.provider.trim()
  && typeof value.model === "string"
  && value.model.length > 0
  && value.model.length <= 256
  && value.model === value.model.trim()

const isContinuation = (
  value: unknown,
): value is WebSearchHistoryContinuation => {
  if (!isRecord(value)) {
    return false
  }
  if (value.kind === "complete") {
    return hasExactFields(value, ["kind"])
  }
  if (!isUniqueStableIdArray(value.pending_server_tool_use_ids)) {
    return false
  }
  if (value.kind === "pause_turn") {
    return hasExactFields(value, ["kind", "pending_server_tool_use_ids"])
  }
  return (
    value.kind === "waiting_client_tools"
    && hasExactFields(value, [
      "kind",
      "pending_client_tool_use_ids",
      "pending_server_tool_use_ids",
    ])
    && isUniqueStableIdArray(value.pending_client_tool_use_ids)
    && areDisjoint(
      value.pending_server_tool_use_ids,
      value.pending_client_tool_use_ids,
    )
  )
}

const isUniqueStableIdArray = (
  value: unknown,
): value is ReadonlyArray<string> => {
  if (
    !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype
    || value.length === 0
    || value.length > WEB_SEARCH_HISTORY_MAX_OUTPUT_ITEMS
  ) {
    return false
  }
  const ids = new Set<string>()
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return false
    const id: unknown = value[index]
    if (!isStableId(id) || ids.has(id)) return false
    ids.add(id)
  }
  return Reflect.ownKeys(value).length === value.length + 1
}

const areDisjoint = (
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>,
): boolean => {
  const leftIds = new Set(left)
  return right.every((id) => !leftIds.has(id))
}

const hasExactFields = (
  value: Record<string, unknown>,
  fields: ReadonlyArray<string>,
): boolean =>
  Object.keys(value).length === fields.length
  && fields.every((field) => Object.hasOwn(value, field))

type CanonicalJsonResult =
  | { nodeCount: number; valid: true; value: unknown }
  | {
      reason: "malformed" | "too-large"
      topLevelField?: string
      valid: false
    }

interface CanonicalJsonFrame {
  depth: number
  key: PropertyKey
  parent: Array<unknown> | Record<string, unknown>
  source: unknown
  topLevelField?: string
}

const canonicalizeJsonValue = (root: unknown): CanonicalJsonResult => {
  const seen = new Set<object>()
  const rootHolder: Record<string, unknown> = {}
  const stack: Array<CanonicalJsonFrame> = [
    {
      depth: 0,
      key: "value",
      parent: rootHolder,
      source: root,
    },
  ]
  let processedNodes = 0
  let activeTopLevelField: string | undefined

  try {
    while (stack.length > 0) {
      const current = stack.pop()
      if (!current) continue
      activeTopLevelField = current.topLevelField
      processedNodes += 1
      if (processedNodes > WEB_SEARCH_HISTORY_MAX_TOTAL_NODES) {
        return {
          valid: false,
          reason: "too-large",
          topLevelField: current.topLevelField,
        }
      }
      const { depth, source } = current
      if (depth > 64) {
        return {
          valid: false,
          reason: "too-large",
          topLevelField: current.topLevelField,
        }
      }
      if (
        source === null
        || typeof source === "string"
        || typeof source === "boolean"
      ) {
        assignCanonicalValue(current, source)
        continue
      }
      if (typeof source === "number") {
        if (!Number.isFinite(source) || Object.is(source, -0)) {
          return {
            valid: false,
            reason: "malformed",
            topLevelField: current.topLevelField,
          }
        }
        assignCanonicalValue(current, source)
        continue
      }
      if (typeof source !== "object" || seen.has(source)) {
        return {
          valid: false,
          reason: "malformed",
          topLevelField: current.topLevelField,
        }
      }
      seen.add(source)

      const prototype: unknown = Object.getPrototypeOf(source)
      if (Array.isArray(source)) {
        const lengthDescriptor = Object.getOwnPropertyDescriptor(
          source,
          "length",
        )
        if (
          !isOwnDataDescriptor(lengthDescriptor)
          || typeof lengthDescriptor.value !== "number"
          || !Number.isSafeInteger(lengthDescriptor.value)
          || lengthDescriptor.value < 0
        ) {
          return {
            valid: false,
            reason: "malformed",
            topLevelField: current.topLevelField,
          }
        }
        const length = lengthDescriptor.value
        if (length > WEB_SEARCH_HISTORY_MAX_COLLECTION_WIDTH) {
          return {
            valid: false,
            reason: "too-large",
            topLevelField: current.topLevelField,
          }
        }
        const keys = Reflect.ownKeys(source)
        if (
          prototype !== Array.prototype
          || keys.length !== length + 1
          || !Object.hasOwn(source, "length")
        ) {
          return {
            valid: false,
            reason: "malformed",
            topLevelField: current.topLevelField,
          }
        }
        if (!canReserveChildren(processedNodes, stack.length, length)) {
          return {
            valid: false,
            reason: "too-large",
            topLevelField: current.topLevelField,
          }
        }
        const clone = new Array<unknown>(length)
        assignCanonicalValue(current, clone)
        for (let index = length - 1; index >= 0; index -= 1) {
          const descriptor = Object.getOwnPropertyDescriptor(source, index)
          if (!isOwnEnumerableDataDescriptor(descriptor)) {
            return {
              valid: false,
              reason: "malformed",
              topLevelField: current.topLevelField,
            }
          }
          stack.push({
            depth: depth + 1,
            key: index,
            parent: clone,
            source: descriptor.value,
            topLevelField: current.topLevelField,
          })
        }
        continue
      }
      if (prototype !== Object.prototype && prototype !== null) {
        return {
          valid: false,
          reason: "malformed",
          topLevelField: current.topLevelField,
        }
      }
      const keys = Reflect.ownKeys(source)
      if (keys.length > WEB_SEARCH_HISTORY_MAX_COLLECTION_WIDTH) {
        return {
          valid: false,
          reason: "too-large",
          topLevelField: current.topLevelField,
        }
      }
      if (!canReserveChildren(processedNodes, stack.length, keys.length)) {
        return {
          valid: false,
          reason: "too-large",
          topLevelField: current.topLevelField,
        }
      }
      const clone: Record<string, unknown> = {}
      assignCanonicalValue(current, clone)
      for (let index = keys.length - 1; index >= 0; index -= 1) {
        const key = keys[index]
        const topLevelField =
          depth === 0 && typeof key === "string" ? key : current.topLevelField
        if (typeof key !== "string") {
          return {
            valid: false,
            reason: "malformed",
            topLevelField,
          }
        }
        const descriptor = Object.getOwnPropertyDescriptor(source, key)
        if (!isOwnEnumerableDataDescriptor(descriptor)) {
          return {
            valid: false,
            reason: "malformed",
            topLevelField,
          }
        }
        stack.push({
          depth: depth + 1,
          key,
          parent: clone,
          source: descriptor.value,
          topLevelField,
        })
      }
    }
  } catch {
    return {
      valid: false,
      reason: "malformed",
      topLevelField: activeTopLevelField,
    }
  }

  return { nodeCount: processedNodes, valid: true, value: rootHolder.value }
}

const canReserveChildren = (
  processedNodes: number,
  queuedNodes: number,
  newChildren: number,
): boolean =>
  processedNodes + queuedNodes + newChildren
  <= WEB_SEARCH_HISTORY_MAX_TOTAL_NODES

const assignCanonicalValue = (
  frame: CanonicalJsonFrame,
  value: unknown,
): void => {
  Object.defineProperty(frame.parent, frame.key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  })
}

const isOwnDataDescriptor = (
  descriptor: PropertyDescriptor | undefined,
): descriptor is PropertyDescriptor & { value: unknown } =>
  descriptor !== undefined && Object.hasOwn(descriptor, "value")

const isOwnEnumerableDataDescriptor = (
  descriptor: PropertyDescriptor | undefined,
): descriptor is PropertyDescriptor & { value: unknown } =>
  isOwnDataDescriptor(descriptor) && descriptor.enumerable === true

const isOutputItemContract = (value: Record<string, unknown>): boolean =>
  isStableType(value.type)
  && isOptionalStableId(value.id)
  && (value.type !== "web_search_call" || isStableId(value.id))

const isStableType = (value: unknown): value is string =>
  typeof value === "string"
  && value.length > 0
  && value.length <= 128
  && value === value.trim()

const isStableId = (value: unknown): value is string =>
  typeof value === "string"
  && value.length > 0
  && value.length <= 512
  && value === value.trim()

const isOptionalStableId = (value: unknown): boolean =>
  value === undefined || isStableId(value)

const deepFreezeJson = <T>(root: T): T => {
  const seen = new Set<object>()
  const stack: Array<unknown> = [root]
  let nodeCount = 0

  while (stack.length > 0) {
    const value = stack.pop()
    if (typeof value !== "object" || value === null || seen.has(value)) {
      continue
    }
    nodeCount += 1
    if (nodeCount > WEB_SEARCH_HISTORY_MAX_TOTAL_NODES) {
      throw new Error("Validated Web Search carrier exceeded freeze budget")
    }
    seen.add(value)
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        stack.push(value[index])
      }
    } else {
      for (const child of Object.values(value)) {
        stack.push(child)
      }
    }
    Object.freeze(value)
  }

  return root
}
