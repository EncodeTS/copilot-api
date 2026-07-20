import { expect, test } from "bun:test"

import {
  decodeZstdInRuntime,
  ZstdRuntimeUnavailableError,
  type ZstdRuntimeDependencies,
} from "../src/lib/zstd-runtime"

const emptyFrame = new Uint8Array([
  0x28, 0xb5, 0x2f, 0xfd, 0x20, 0x00, 0x01, 0x00, 0x00,
])
const oneByteFrame = new Uint8Array([
  0x28, 0xb5, 0x2f, 0xfd, 0x20, 0x01, 0x09, 0x00, 0x00, 0x01,
])

test("zero-output fast path accepts FCS zero in auto mode", async () => {
  const output = await decodeZstdInRuntime(emptyFrame, {
    decodedBytes: 0,
    decoderPreference: "auto",
  })

  expect(output.byteLength).toBe(0)
})

test("zero-output fast path accepts FCS zero in forced-WASM mode", async () => {
  const output = await decodeZstdInRuntime(emptyFrame, {
    decodedBytes: 0,
    decoderPreference: "wasm",
  })

  expect(output.byteLength).toBe(0)
})

test("default native zstd runtime decodes a nonempty frame", async () => {
  const output = await decodeZstdInRuntime(oneByteFrame, {
    decodedBytes: 1,
    decoderPreference: "auto",
  })

  expect(output).toEqual(new Uint8Array([1]))
})

test("default WASM zstd runtime decodes a nonempty frame", async () => {
  const output = await decodeZstdInRuntime(oneByteFrame, {
    decodedBytes: 1,
    decoderPreference: "wasm",
  })

  expect(output).toEqual(new Uint8Array([1]))
})

test("native zstd runtime uses a positive API allocation limit", async () => {
  let maxOutputLength: number | undefined
  const dependencies: ZstdRuntimeDependencies = {
    loadNative: () =>
      Promise.resolve({
        zstdDecompressSync(_input, options) {
          maxOutputLength = options.maxOutputLength
          return new Uint8Array([1])
        },
      }),
    loadWasm: () => Promise.reject(new Error("must not load wasm")),
  }

  const output = await decodeZstdInRuntime(
    oneByteFrame,
    { decodedBytes: 1, decoderPreference: "auto" },
    dependencies,
  )

  expect(maxOutputLength).toBe(1)
  expect(output.byteLength).toBe(1)
})

test("wasm zstd runtime preserves known FCS zero without a guessed output allocation", async () => {
  let loadCalls = 0
  let decodeCalls = 0
  const dependencies: ZstdRuntimeDependencies = {
    loadNative: () => Promise.resolve(null),
    loadWasm: () =>
      Promise.resolve({
        load() {
          loadCalls += 1
          return Promise.resolve({
            decompress() {
              decodeCalls += 1
              return new Uint8Array()
            },
          })
        },
      }),
  }

  const output = await decodeZstdInRuntime(
    emptyFrame,
    { decodedBytes: 0, decoderPreference: "wasm" },
    dependencies,
  )

  expect(loadCalls).toBe(0)
  expect(decodeCalls).toBe(0)
  expect(output.byteLength).toBe(0)
})

test("wasm zstd runtime classifies module import failure as unavailable", async () => {
  const dependencies: ZstdRuntimeDependencies = {
    loadNative: () => Promise.resolve(null),
    loadWasm: () => Promise.reject(new Error("module missing")),
  }

  const error = await decodeZstdInRuntime(
    oneByteFrame,
    { decodedBytes: 1, decoderPreference: "wasm" },
    dependencies,
  ).catch((caught: unknown) => caught)

  expect(error).toBeInstanceOf(ZstdRuntimeUnavailableError)
})

test("wasm zstd runtime classifies initialization failure as unavailable", async () => {
  const dependencies: ZstdRuntimeDependencies = {
    loadNative: () => Promise.resolve(null),
    loadWasm: () =>
      Promise.resolve({
        load: () => Promise.reject(new Error("wasm init failed")),
      }),
  }

  const error = await decodeZstdInRuntime(
    oneByteFrame,
    { decodedBytes: 1, decoderPreference: "wasm" },
    dependencies,
  ).catch((caught: unknown) => caught)

  expect(error).toBeInstanceOf(ZstdRuntimeUnavailableError)
})
