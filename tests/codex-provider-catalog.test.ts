import { describe, expect, mock, test } from "bun:test"

import { createCodexProviderCatalogManager } from "~/services/codex/get-models"
import type { ModelsResponse } from "~/services/copilot/get-models"
import type { CodexCredentialSnapshot } from "~/services/codex/get-models"

const credentialsA: CodexCredentialSnapshot = {
  accessToken: "token-a",
  accountId: "account-a",
  credentialRevision: 1,
}
const credentialsB: CodexCredentialSnapshot = {
  accessToken: "token-b",
  accountId: "account-b",
  credentialRevision: 2,
}
const credentialsARotated: CodexCredentialSnapshot = {
  accessToken: "token-a-rotated",
  accountId: "account-a",
  credentialRevision: 2,
}
const credentialsC: CodexCredentialSnapshot = {
  accessToken: "token-c",
  accountId: "account-c",
  credentialRevision: 3,
}

const createOfficialDescriptor = (overrides: Record<string, unknown> = {}) => ({
  slug: "gpt-5.6-sol",
  display_name: "GPT-5.6 Sol",
  visibility: "list",
  supported_in_api: true,
  input_modalities: ["text", "image"],
  context_window: 372_000,
  max_context_window: 1_000_000,
  default_reasoning_level: "low",
  supported_reasoning_levels: [
    { effort: "low" },
    { effort: "max" },
    { effort: "ultra" },
  ],
  supports_parallel_tool_calls: true,
  ...overrides,
})

const expectRejection = async (
  promise: Promise<unknown>,
  message: string,
): Promise<void> => {
  let rejection: unknown
  try {
    await promise
  } catch (error) {
    rejection = error
  }
  expect(rejection).toBeInstanceOf(Error)
  if (!(rejection instanceof Error)) {
    throw new TypeError("Expected promise rejection")
  }
  expect(rejection.message).toBe(message)
}

describe("Codex provider catalog", () => {
  test("combines official descriptor fields with documented adapter invariants", async () => {
    const manager = createCodexProviderCatalogManager({
      fetchOfficialCatalog: () =>
        Promise.resolve(
          Response.json({
            models: [
              createOfficialDescriptor(),
              createOfficialDescriptor({
                slug: "hidden-model",
                visibility: "hide",
              }),
              createOfficialDescriptor({
                slug: "client-only-model",
                supported_in_api: false,
              }),
            ],
          }),
        ),
      now: () => 1_000,
    })

    const result = await manager.load({
      credentials: credentialsA,
    })

    expect(result).toEqual({
      catalog: {
        object: "list",
        data: [
          {
            capabilities: {
              family: "gpt-5.6-sol",
              limits: {
                max_context_window_tokens: 1_000_000,
                max_prompt_tokens: 372_000,
              },
              object: "model_capabilities",
              supports: {
                adaptive_thinking: true,
                parallel_tool_calls: true,
                reasoning_effort: ["low", "max", "ultra"],
                streaming: true,
                tool_calls: true,
                vision: true,
              },
              type: "chat",
            },
            id: "gpt-5.6-sol",
            model_picker_enabled: true,
            name: "GPT-5.6 Sol",
            object: "model",
            supported_endpoints: ["/v1/messages", "/v1/responses"],
            vendor: "openai",
            version: "codex-official",
          },
        ],
      },
      diagnostics: [],
      fetchedAt: 1_000,
      freshness: "fresh",
      source: "official",
    })
  })

  test("does not invent tool capability absent from the descriptor", async () => {
    const manager = createCodexProviderCatalogManager({
      fetchOfficialCatalog: () =>
        Promise.resolve(
          Response.json({
            models: [
              createOfficialDescriptor({
                supports_parallel_tool_calls: false,
              }),
            ],
          }),
        ),
    })

    const model = (await manager.load({ credentials: credentialsA })).catalog
      .data[0]

    expect(model?.capabilities.supports.parallel_tool_calls).toBeFalse()
    expect(model?.capabilities.supports.tool_calls).toBeFalse()
  })

  test("uses an explicit degraded fallback when official discovery is unavailable", async () => {
    const staticFallback: ModelsResponse = {
      object: "list",
      data: [
        {
          capabilities: {
            family: "fallback-model",
            limits: { max_prompt_tokens: 100_000 },
            object: "model_capabilities",
            supports: { streaming: true },
            tokenizer: "o200k_base",
            type: "chat",
          },
          id: "fallback-model",
          model_picker_enabled: true,
          name: "Fallback model",
          object: "model",
          preview: false,
          vendor: "openai",
          version: "static-fallback",
        },
      ],
    }
    const manager = createCodexProviderCatalogManager({
      fetchOfficialCatalog: () =>
        Promise.reject(new Error("request included secret-token")),
      now: () => 2_000,
      staticFallback,
    })

    const result = await manager.load({
      credentials: credentialsA,
    })

    expect(result).toEqual({
      catalog: staticFallback,
      diagnostics: [
        { code: "official_unavailable" },
        { code: "static_capability_degraded" },
        { code: "static_effort_filtered" },
      ],
      fetchedAt: null,
      freshness: "degraded",
      source: "static_fallback",
    })
    expect(JSON.stringify(result)).not.toContain("secret-token")
  })

  test("keeps a scoped last-known-good when a later refresh fails", async () => {
    let now = 1_000
    const fetchOfficialCatalog = mock(() =>
      fetchOfficialCatalog.mock.calls.length === 1 ?
        Promise.resolve(
          Response.json({
            models: [
              createOfficialDescriptor({
                supported_reasoning_levels: [
                  { effort: "low" },
                  { effort: "future-hyper" },
                ],
              }),
            ],
          }),
        )
      : Promise.resolve(
          Response.json({
            models: [createOfficialDescriptor({ context_window: "invalid" })],
          }),
        ),
    )
    const manager = createCodexProviderCatalogManager({
      cacheTtlMs: 500,
      fetchOfficialCatalog,
      now: () => now,
    })

    const live = await manager.load({
      credentials: credentialsA,
    })
    now = 2_000
    const stale = await manager.load({
      credentials: credentialsA,
    })

    expect(live.source).toBe("official")
    expect(stale).toEqual({
      ...live,
      diagnostics: [
        {
          code: "unsupported_reasoning_effort",
          model: "gpt-5.6-sol",
          value: "future-hyper",
        },
        { code: "official_catalog_invalid" },
      ],
      freshness: "stale",
      source: "last_known_good",
    })
    expect(fetchOfficialCatalog).toHaveBeenCalledTimes(2)
  })

  test("accepts an authoritative empty official catalog", async () => {
    const manager = createCodexProviderCatalogManager({
      fetchOfficialCatalog: () =>
        Promise.resolve(Response.json({ models: [] })),
    })

    const result = await manager.load({ credentials: credentialsA })
    expect(typeof result.fetchedAt).toBe("number")
    expect({ ...result, fetchedAt: null }).toEqual({
      catalog: { data: [], object: "list" },
      diagnostics: [],
      fetchedAt: null,
      freshness: "fresh",
      source: "official",
    })
  })

  test("rejects a non-empty official catalog with zero valid projections", async () => {
    const manager = createCodexProviderCatalogManager({
      fetchOfficialCatalog: () =>
        Promise.resolve(
          Response.json({
            models: [
              createOfficialDescriptor({
                context_window: "invalid",
                slug: "invalid-model",
              }),
            ],
          }),
        ),
    })

    const result = await manager.load({ credentials: credentialsA })

    expect(result.source).toBe("static_fallback")
    expect(result.diagnostics.map(({ code }) => code)).toEqual([
      "official_catalog_invalid",
      "static_capability_degraded",
      "static_effort_filtered",
    ])
  })

  test("bounds official discovery with an aborting timeout", async () => {
    let observedAbort = false
    const manager = createCodexProviderCatalogManager({
      fetchOfficialCatalog: (_credentials, signal) =>
        new Promise<Response>(() => {
          signal?.addEventListener(
            "abort",
            () => {
              observedAbort = true
            },
            { once: true },
          )
        }),
      requestTimeoutMs: 5,
    })

    const result = await manager.load({
      credentials: credentialsA,
    })

    expect(observedAbort).toBeTrue()
    expect(result).toMatchObject({
      diagnostics: [
        { code: "official_unavailable" },
        { code: "static_capability_degraded" },
        { code: "static_effort_filtered" },
      ],
      freshness: "degraded",
      source: "static_fallback",
    })
  })

  test("does not let an older discovery generation replace newer last-known-good", async () => {
    let resolveOlder!: (response: Response) => void
    let resolveNewer!: (response: Response) => void
    const older = new Promise<Response>((resolve) => {
      resolveOlder = resolve
    })
    const newer = new Promise<Response>((resolve) => {
      resolveNewer = resolve
    })
    let now = 1_000
    let call = 0
    const manager = createCodexProviderCatalogManager({
      cacheTtlMs: 1,
      fetchOfficialCatalog: () => {
        call += 1
        if (call === 1) return older
        if (call === 2) return newer
        return Promise.reject(new Error("offline"))
      },
      now: () => now,
    })

    const olderLoad = manager.load({
      forceRefresh: true,
      credentials: credentialsA,
    })
    const newerLoad = manager.load({
      forceRefresh: true,
      credentials: credentialsA,
    })
    resolveNewer(
      Response.json({
        models: [createOfficialDescriptor({ slug: "newer-model" })],
      }),
    )
    expect((await newerLoad).catalog.data[0]?.id).toBe("newer-model")
    resolveOlder(
      Response.json({
        models: [createOfficialDescriptor({ slug: "older-model" })],
      }),
    )
    expect((await olderLoad).catalog.data[0]?.id).toBe("older-model")

    now = 2_000
    const stale = await manager.load({
      credentials: credentialsA,
    })

    expect(stale.source).toBe("last_known_good")
    expect(stale.catalog.data[0]?.id).toBe("newer-model")
  })

  test("binds refresh authentication and LKG commit to one credential snapshot", async () => {
    let resolveAccountA!: (response: Response) => void
    const accountAResponse = new Promise<Response>((resolve) => {
      resolveAccountA = resolve
    })
    const observedCredentials: Array<CodexCredentialSnapshot> = []
    let call = 0
    const manager = createCodexProviderCatalogManager({
      cacheTtlMs: 1,
      fetchOfficialCatalog: (credentials) => {
        observedCredentials.push(credentials)
        call += 1
        if (call === 1) return accountAResponse
        if (call === 2) {
          return Promise.resolve(
            Response.json({
              models: [createOfficialDescriptor({ slug: "account-b-model" })],
            }),
          )
        }
        return Promise.reject(new Error("account A offline"))
      },
    })

    const accountALoad = manager.load({ credentials: credentialsA })
    const accountB = await manager.load({ credentials: credentialsB })
    resolveAccountA(
      Response.json({
        models: [createOfficialDescriptor({ slug: "account-a-model" })],
      }),
    )
    const accountA = await accountALoad

    expect(observedCredentials.slice(0, 2)).toEqual([
      credentialsA,
      credentialsB,
    ])
    expect(accountA.catalog.data[0]?.id).toBe("account-a-model")
    expect(accountB.catalog.data[0]?.id).toBe("account-b-model")
    const accountAStale = await manager.load({
      credentials: credentialsA,
      forceRefresh: true,
    })
    expect(accountAStale.source).toBe("last_known_good")
    expect(accountAStale.catalog.data[0]?.id).toBe("account-a-model")
  })

  test("reuses account LKG after same-account token rotation refresh fails", async () => {
    let call = 0
    const manager = createCodexProviderCatalogManager({
      fetchOfficialCatalog: (credentials) => {
        call += 1
        return credentials.credentialRevision === 1 ?
            Promise.resolve(
              Response.json({
                models: [createOfficialDescriptor({ slug: "account-a-model" })],
              }),
            )
          : Promise.reject(new Error("rotated token discovery failed"))
      },
    })

    await manager.load({ credentials: credentialsA })
    const rotated = await manager.load({ credentials: credentialsARotated })

    expect(call).toBe(2)
    expect(rotated.source).toBe("last_known_good")
    expect(rotated.catalog.data[0]?.id).toBe("account-a-model")
  })

  test("never reuses LKG across different accounts", async () => {
    const manager = createCodexProviderCatalogManager({
      fetchOfficialCatalog: (credentials) =>
        credentials.accountId === "account-a" ?
          Promise.resolve(
            Response.json({
              models: [createOfficialDescriptor({ slug: "account-a-model" })],
            }),
          )
        : Promise.reject(new Error("account B unavailable")),
    })

    await manager.load({ credentials: credentialsA })
    const accountB = await manager.load({ credentials: credentialsB })

    expect(accountB.source).toBe("static_fallback")
    expect(accountB.catalog.data.map(({ id }) => id)).not.toContain(
      "account-a-model",
    )
  })

  test("does not let an old revision finish over newer account LKG", async () => {
    let resolveOldRevision!: (response: Response) => void
    const oldRevision = new Promise<Response>((resolve) => {
      resolveOldRevision = resolve
    })
    let rotatedCalls = 0
    const manager = createCodexProviderCatalogManager({
      fetchOfficialCatalog: (credentials) => {
        if (credentials.credentialRevision === 1) return oldRevision
        rotatedCalls += 1
        return rotatedCalls === 1 ?
            Promise.resolve(
              Response.json({
                models: [
                  createOfficialDescriptor({ slug: "new-revision-model" }),
                ],
              }),
            )
          : Promise.reject(new Error("new revision temporarily unavailable"))
      },
    })

    const oldLoad = manager.load({ credentials: credentialsA })
    await manager.load({ credentials: credentialsARotated })
    resolveOldRevision(
      Response.json({
        models: [createOfficialDescriptor({ slug: "old-revision-model" })],
      }),
    )
    await oldLoad
    const fallback = await manager.load({
      credentials: credentialsARotated,
      forceRefresh: true,
    })

    expect(fallback.source).toBe("last_known_good")
    expect(fallback.catalog.data[0]?.id).toBe("new-revision-model")
  })

  test("does not let a lower revision arriving later replace account truth", async () => {
    let rotatedCalls = 0
    let oldRevisionCalls = 0
    const manager = createCodexProviderCatalogManager({
      fetchOfficialCatalog: (credentials) => {
        if (credentials.credentialRevision === 1) {
          oldRevisionCalls += 1
          return Promise.resolve(
            Response.json({
              models: [createOfficialDescriptor({ slug: "old-model" })],
            }),
          )
        }
        rotatedCalls += 1
        return rotatedCalls === 1 ?
            Promise.resolve(
              Response.json({
                models: [createOfficialDescriptor({ slug: "new-model" })],
              }),
            )
          : Promise.reject(new Error("rev2 transient failure"))
      },
    })

    await manager.load({ credentials: credentialsARotated })
    const lateOldRevision = await manager.load({ credentials: credentialsA })

    expect(oldRevisionCalls).toBe(0)
    expect(lateOldRevision.catalog.data[0]?.id).toBe("new-model")
    const fallback = await manager.load({
      credentials: credentialsARotated,
      forceRefresh: true,
    })
    expect(fallback.source).toBe("last_known_good")
    expect(fallback.catalog.data[0]?.id).toBe("new-model")
  })

  test("deduplicates concurrent loads for the same credential revision", async () => {
    let resolveRefresh!: (response: Response) => void
    const fetchOfficialCatalog = mock(
      () =>
        new Promise<Response>((resolve) => {
          resolveRefresh = resolve
        }),
    )
    const manager = createCodexProviderCatalogManager({
      fetchOfficialCatalog,
    })

    const first = manager.load({ credentials: credentialsARotated })
    const second = manager.load({ credentials: credentialsARotated })
    await Promise.resolve()
    expect(fetchOfficialCatalog).toHaveBeenCalledTimes(1)
    resolveRefresh(Response.json({ models: [createOfficialDescriptor()] }))

    expect(await first).toEqual(await second)
    expect(fetchOfficialCatalog).toHaveBeenCalledTimes(1)
  })

  test("diagnoses reasoning efforts the gateway deliberately filters", async () => {
    const manager = createCodexProviderCatalogManager({
      fetchOfficialCatalog: () =>
        Promise.resolve(
          Response.json({
            models: [
              createOfficialDescriptor({
                supported_reasoning_levels: [
                  { effort: "low" },
                  { effort: "ultra" },
                  { effort: "future-hyper" },
                ],
              }),
            ],
          }),
        ),
    })

    const result = await manager.load({
      credentials: credentialsA,
    })

    expect(
      result.catalog.data[0]?.capabilities.supports.reasoning_effort,
    ).toEqual(["low", "ultra"])
    expect(result.diagnostics).toEqual([
      {
        code: "unsupported_reasoning_effort",
        model: "gpt-5.6-sol",
        value: "future-hyper",
      },
    ])
  })

  test("keeps a shared refresh alive when its first waiter cancels", async () => {
    const firstController = new AbortController()
    let resolveRefresh!: (response: Response) => void
    let observedRefreshSignal: AbortSignal | undefined
    const refresh = new Promise<Response>((resolve) => {
      resolveRefresh = resolve
    })
    const fetchOfficialCatalog = mock((_credentials, signal?: AbortSignal) => {
      observedRefreshSignal = signal
      return refresh
    })
    const manager = createCodexProviderCatalogManager({
      fetchOfficialCatalog,
    })
    const firstWaiter = manager.load({
      credentials: credentialsA,
      signal: firstController.signal,
    })
    const secondWaiter = manager.load({ credentials: credentialsA })

    firstController.abort(new Error("first caller cancelled"))

    await expectRejection(firstWaiter, "first caller cancelled")
    expect(observedRefreshSignal?.aborted).toBeFalse()
    resolveRefresh(Response.json({ models: [createOfficialDescriptor()] }))
    expect((await secondWaiter).source).toBe("official")
    expect(fetchOfficialCatalog).toHaveBeenCalledTimes(1)
    expect((await manager.load({ credentials: credentialsA })).source).toBe(
      "official",
    )
    expect(fetchOfficialCatalog).toHaveBeenCalledTimes(1)
  })

  test("lets a later waiter cancel without cancelling the shared refresh", async () => {
    const secondController = new AbortController()
    let resolveRefresh!: (response: Response) => void
    const manager = createCodexProviderCatalogManager({
      fetchOfficialCatalog: () =>
        new Promise<Response>((resolve) => {
          resolveRefresh = resolve
        }),
    })
    const firstWaiter = manager.load({ credentials: credentialsA })
    const secondWaiter = manager.load({
      credentials: credentialsA,
      signal: secondController.signal,
    })

    secondController.abort(new Error("second caller cancelled"))

    await expectRejection(secondWaiter, "second caller cancelled")
    resolveRefresh(Response.json({ models: [createOfficialDescriptor()] }))
    expect((await firstWaiter).source).toBe("official")
  })

  test("keeps late cancelled refreshes within the unified LRU bound", async () => {
    let resolveAccountA!: (response: Response) => void
    const accountAController = new AbortController()
    const accountAResponse = new Promise<Response>((resolve) => {
      resolveAccountA = resolve
    })
    let call = 0
    const manager = createCodexProviderCatalogManager({
      cacheMaxEntries: 1,
      fetchOfficialCatalog: () => {
        call += 1
        if (call === 1) return accountAResponse
        if (call === 2) {
          return Promise.resolve(
            Response.json({
              models: [createOfficialDescriptor({ slug: "account-b-model" })],
            }),
          )
        }
        return Promise.reject(new Error("offline"))
      },
    })

    const accountALoad = manager.load({
      credentials: credentialsA,
      signal: accountAController.signal,
    })
    await manager.load({
      credentials: credentialsB,
    })
    accountAController.abort(new Error("account A disconnected"))
    await expectRejection(accountALoad, "account A disconnected")
    resolveAccountA(
      Response.json({
        models: [createOfficialDescriptor({ slug: "account-a-model" })],
      }),
    )
    await Promise.resolve()
    await Promise.resolve()
    await manager.load({
      credentials: credentialsC,
    })

    const evictedAccount = await manager.load({
      forceRefresh: true,
      credentials: credentialsA,
    })

    expect(evictedAccount.source).toBe("static_fallback")
  })
})
