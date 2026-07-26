import type { Context } from "hono"

import { HTTPError } from "~/lib/error"

/**
 * Edge validation for inbound protocol payloads.
 *
 * `c.req.json<T>()` is an unchecked assertion: TypeScript believes the body
 * matches the declared interface while the runtime value is arbitrary JSON.
 * Every translation layer downstream then trusts that shape, so a malformed
 * body surfaces as a 500 carrying an internal JavaScript message instead of the
 * protocol-native 400 the upstream API would return.
 *
 * Scope is deliberately narrow: only the structural contract whose violation
 * crashes local translation is enforced here. Anything upstream already rejects
 * is forwarded untouched so its authoritative error message wins, and anything
 * upstream accepts keeps working.
 */

export type RequestPayloadProtocol = "anthropic" | "openai"

export const INVALID_REQUEST_BODY_CODE = "invalid_request_body"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const describeJsonType = (value: unknown): string => {
  if (value === null) return "null"
  if (Array.isArray(value)) return "an array"
  switch (typeof value) {
    case "string":
      return "a string"
    case "boolean":
      return "a boolean"
    case "number":
      return Number.isInteger(value) ? "an integer" : "a number"
    default:
      return "an object"
  }
}

const buildErrorBody = (
  protocol: RequestPayloadProtocol,
  message: string,
  param?: string,
): unknown => {
  if (protocol === "anthropic") {
    return {
      type: "error",
      error: { type: "invalid_request_error", message },
    }
  }

  return {
    error: {
      code: INVALID_REQUEST_BODY_CODE,
      message,
      ...(param === undefined ? {} : { param }),
      type: "invalid_request_error",
    },
  }
}

export const createInvalidPayloadError = (
  protocol: RequestPayloadProtocol,
  message: string,
  param?: string,
): HTTPError =>
  new HTTPError(
    message,
    new Response(JSON.stringify(buildErrorBody(protocol, message, param)), {
      status: 400,
      headers: { "content-type": "application/json" },
    }),
  )

/** Container type enforced for a field whose wrong type crashes translation. */
export type FieldContainer = "array" | "object" | "stringOrArray"

export interface FieldRule {
  field: string
  /** Reject an absent field. */
  required?: boolean
  /**
   * Reject a present value of the wrong container type. Set only where the
   * wrong type crashes locally; otherwise upstream owns the rejection.
   */
  container?: FieldContainer
  /** Reject non-object members when the value is an array. */
  objectMembers?: boolean
}

export interface PayloadShapeSpec {
  fields: Array<FieldRule>
  /** Fields holding messages whose nested `content` is walked by translators. */
  contentFields: Array<string>
}

const assertObjectMembers = (
  protocol: RequestPayloadProtocol,
  field: string,
  value: Array<unknown>,
): void => {
  for (const [index, member] of value.entries()) {
    if (isRecord(member)) continue
    const param = `${field}[${index}]`
    throw createInvalidPayloadError(
      protocol,
      `Invalid type for '${param}': expected an object, but got ${describeJsonType(member)} instead.`,
      param,
    )
  }
}

const matchesContainer = (
  container: FieldContainer,
  value: unknown,
): boolean => {
  switch (container) {
    case "array": {
      return Array.isArray(value)
    }
    case "object": {
      return isRecord(value)
    }
    case "stringOrArray": {
      return typeof value === "string" || Array.isArray(value)
    }
  }
}

const describeContainer = (container: FieldContainer): string => {
  switch (container) {
    case "array": {
      return "an array"
    }
    case "object": {
      return "an object"
    }
    case "stringOrArray": {
      return "one of a string or an array"
    }
  }
}

const assertField = (
  protocol: RequestPayloadProtocol,
  payload: Record<string, unknown>,
  rule: FieldRule,
): void => {
  const value = payload[rule.field]
  if (value === undefined || value === null) {
    if (rule.required) {
      throw createInvalidPayloadError(
        protocol,
        `Missing required parameter: '${rule.field}'.`,
        rule.field,
      )
    }
    return
  }

  if (rule.container && !matchesContainer(rule.container, value)) {
    throw createInvalidPayloadError(
      protocol,
      `Invalid type for '${rule.field}': expected ${describeContainer(rule.container)}, but got ${describeJsonType(value)} instead.`,
      rule.field,
    )
  }

  if (rule.objectMembers && Array.isArray(value)) {
    assertObjectMembers(protocol, rule.field, value)
  }
}

const assertModel = (
  protocol: RequestPayloadProtocol,
  payload: Record<string, unknown>,
): void => {
  const model = payload.model
  if (model === undefined || model === null) {
    throw createInvalidPayloadError(
      protocol,
      "Missing required parameter: 'model'.",
      "model",
    )
  }

  if (typeof model !== "string") {
    throw createInvalidPayloadError(
      protocol,
      `Invalid type for 'model': expected a string, but got ${describeJsonType(model)} instead.`,
      "model",
    )
  }

  if (model.trim() === "") {
    throw createInvalidPayloadError(
      protocol,
      "Invalid value for 'model': expected a non-empty string.",
      "model",
    )
  }
}

/** Message-scoped `content` blocks crash translation when they hold null. */
const assertMessageContent = (
  protocol: RequestPayloadProtocol,
  field: string,
  messages: Array<unknown>,
): void => {
  for (const [index, message] of messages.entries()) {
    if (!isRecord(message)) continue
    const content = message.content
    if (content === undefined || content === null) continue
    if (typeof content === "string") continue

    const param = `${field}[${index}].content`
    if (!Array.isArray(content)) {
      throw createInvalidPayloadError(
        protocol,
        `Invalid type for '${param}': expected one of a string or an array, but got ${describeJsonType(content)} instead.`,
        param,
      )
    }

    assertObjectMembers(protocol, param, content)
  }
}

export const assertPayloadShape = (
  protocol: RequestPayloadProtocol,
  value: unknown,
  spec: PayloadShapeSpec,
): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw createInvalidPayloadError(
      protocol,
      `Invalid type for the request body: expected an object, but got ${describeJsonType(value)} instead.`,
    )
  }

  assertModel(protocol, value)

  for (const rule of spec.fields) assertField(protocol, value, rule)

  for (const field of spec.contentFields) {
    const messages = value[field]
    if (Array.isArray(messages)) {
      assertMessageContent(protocol, field, messages)
    }
  }

  return value
}

/**
 * Container enforcement below is limited to fields measured to throw during
 * local translation: `messages.some`, `tools.flatMap`, `tools?.some`,
 * `system.map`, and the `thinking` property write. Fields such as `metadata`,
 * `include`, `reasoning`, `text`, `tool_choice`, and `output_config` are
 * intentionally absent — upstream either accepts them or returns its own 400.
 */
export const ANTHROPIC_MESSAGES_SHAPE: PayloadShapeSpec = {
  fields: [
    {
      field: "messages",
      required: true,
      container: "array",
      objectMembers: true,
    },
    { field: "tools", container: "array", objectMembers: true },
    { field: "system", container: "stringOrArray", objectMembers: true },
    { field: "thinking", container: "object" },
  ],
  contentFields: ["messages"],
}

export const RESPONSES_SHAPE: PayloadShapeSpec = {
  fields: [
    { field: "tools", container: "array", objectMembers: true },
    { field: "input", objectMembers: true },
  ],
  contentFields: [],
}

export const CHAT_COMPLETIONS_SHAPE: PayloadShapeSpec = {
  fields: [
    {
      field: "messages",
      required: true,
      container: "array",
      objectMembers: true,
    },
    { field: "tools", objectMembers: true },
  ],
  contentFields: ["messages"],
}

const readJsonBody = async (
  c: Context,
  protocol: RequestPayloadProtocol,
): Promise<unknown> => {
  try {
    return await c.req.json()
  } catch {
    throw createInvalidPayloadError(
      protocol,
      "The request body is not valid JSON.",
    )
  }
}

/**
 * Parses and structurally validates an inbound protocol payload.
 *
 * Throws an {@link HTTPError} carrying a protocol-native 400 response, which the
 * existing route-level `forwardError` handling forwards verbatim.
 */
export const readValidatedPayload = async <T>(
  c: Context,
  protocol: RequestPayloadProtocol,
  spec: PayloadShapeSpec,
): Promise<T> => {
  const body = await readJsonBody(c, protocol)
  return assertPayloadShape(protocol, body, spec) as T
}

export const readAnthropicMessagesPayload = async <T>(c: Context): Promise<T> =>
  await readValidatedPayload<T>(c, "anthropic", ANTHROPIC_MESSAGES_SHAPE)

export const readResponsesPayload = async <T>(c: Context): Promise<T> =>
  await readValidatedPayload<T>(c, "openai", RESPONSES_SHAPE)

export const readChatCompletionsPayload = async <T>(c: Context): Promise<T> =>
  await readValidatedPayload<T>(c, "openai", CHAT_COMPLETIONS_SHAPE)
