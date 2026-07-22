declare const capacityKeyBrand: unique symbol
declare const poolKeyBrand: unique symbol

export type ResponsesWebSocketCapacityKey = string & {
  readonly [capacityKeyBrand]: true
}

export type ResponsesWebSocketPoolKey = string & {
  readonly [poolKeyBrand]: true
}

export interface PooledWebSocketIdentity {
  readonly capacityKey: ResponsesWebSocketCapacityKey
  readonly poolKey: ResponsesWebSocketPoolKey
}

export interface PooledWebSocketIdentityParts {
  accountFingerprint: string
  origin: string
  poolScope: ReadonlyArray<string>
  provider: string
}

const pooledWebSocketIdentities = new WeakSet<PooledWebSocketIdentity>()

export const createPooledWebSocketIdentity = (
  parts: PooledWebSocketIdentityParts,
): PooledWebSocketIdentity => {
  const provider = requireIdentityPart("provider", parts.provider)
  const origin = new URL(parts.origin).origin
  const accountFingerprint = requireIdentityPart(
    "accountFingerprint",
    parts.accountFingerprint,
  )
  if (parts.poolScope.length === 0) {
    throw new TypeError("Responses websocket pool scope cannot be empty")
  }

  const capacityKey = [provider, origin, accountFingerprint]
    .map(encodeIdentityPart)
    .join("|") as ResponsesWebSocketCapacityKey
  const poolKey = [
    capacityKey,
    ...parts.poolScope.map((part, index) =>
      encodeIdentityPart(requireIdentityPart(`poolScope[${index}]`, part)),
    ),
  ].join("|") as ResponsesWebSocketPoolKey
  const identity = Object.freeze({ capacityKey, poolKey })
  pooledWebSocketIdentities.add(identity)
  return identity
}

export const isPooledWebSocketIdentity = (
  identity: unknown,
): identity is PooledWebSocketIdentity =>
  typeof identity === "object"
  && identity !== null
  && pooledWebSocketIdentities.has(identity as PooledWebSocketIdentity)

const requireIdentityPart = (name: string, value: string): string => {
  if (!value.trim()) {
    throw new TypeError(`Responses websocket identity ${name} cannot be empty`)
  }
  return value
}

const encodeIdentityPart = (value: string): string => encodeURIComponent(value)
