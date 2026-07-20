import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { constants, zstdCompressSync } from "node:zlib"

import { RequestBodyTooLargeError } from "../src/lib/request-body-policy"
import {
  decodeZstdBody,
  createZstdBodyDecoder,
  startZstdDecode,
  ZstdDecodeError,
  ZstdDecoderUnavailableError,
  type ZstdWorkerPort,
} from "../src/lib/zstd-adapter"
import { UnsafeZstdFrameError } from "../src/lib/zstd-frame"

const emptyFrame = new Uint8Array([
  0x28, 0xb5, 0x2f, 0xfd, 0x20, 0x00, 0x01, 0x00, 0x00,
])

const emptyFrameWithChecksum = new Uint8Array([
  0x28, 0xb5, 0x2f, 0xfd, 0x24, 0x00, 0x01, 0x00, 0x00, 0x99, 0xe9, 0xd8, 0x51,
])

test("bounded zstd adapter decodes a frame at the exact output cap", async () => {
  const expected = new TextEncoder().encode('{"ok":true}')
  const compressed = await Bun.zstdCompress(expected)

  const decoded = await decodeZstdBody(compressed, {
    maxDecodedBytes: expected.byteLength,
  })

  expect(decoded.byteLength).toBe(expected.byteLength)
  expect(decoded).toEqual(expected)
})

test("bounded zstd adapter returns proven empty frames without creating a decoder", async () => {
  let workerCreated = false
  const decoder = createZstdBodyDecoder(() => {
    workerCreated = true
    throw new Error("worker must not be created")
  })

  const plain = await decoder.decode(emptyFrame, { maxDecodedBytes: 0 })
  const checksummed = await decoder.decode(emptyFrameWithChecksum, {
    maxDecodedBytes: 0,
  })

  expect(plain.byteLength).toBe(0)
  expect(checksummed.byteLength).toBe(0)
  expect(workerCreated).toBeFalse()
})

test("bounded zstd adapter rejects an invalid empty-frame checksum", async () => {
  const invalidChecksum = emptyFrameWithChecksum.slice()
  invalidChecksum[invalidChecksum.byteLength - 1] ^= 1

  const error = await decodeZstdBody(invalidChecksum, {
    maxDecodedBytes: 0,
  }).catch((caught: unknown) => caught)

  expect(error).toBeInstanceOf(Error)
})

test("bounded zstd adapter fails closed on compressed FCS-zero blocks", async () => {
  const compressedZeroBlock = new Uint8Array([
    0x28, 0xb5, 0x2f, 0xfd, 0x20, 0x00, 0x05, 0x00, 0x00,
  ])

  const error = await decodeZstdBody(compressedZeroBlock, {
    maxDecodedBytes: 0,
  }).catch((caught: unknown) => caught)

  expect(error).toBeInstanceOf(UnsafeZstdFrameError)
})

test("bounded zstd adapter rejects non-single FCS-zero raw output without a decoder", async () => {
  const contradictoryRawFrame = new Uint8Array([
    0x28, 0xb5, 0x2f, 0xfd, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x09, 0x00,
    0x00, 0x41,
  ])
  let workerCreated = false
  const decoder = createZstdBodyDecoder(() => {
    workerCreated = true
    throw new Error("worker must not be created")
  })

  const error = await decoder
    .decode(contradictoryRawFrame, { maxDecodedBytes: 1024 })
    .catch((caught: unknown) => caught)

  expect(error).toBeInstanceOf(UnsafeZstdFrameError)
  expect(workerCreated).toBeFalse()
})

test("bounded zstd adapter rejects non-single FCS-zero RLE output without a decoder", async () => {
  const contradictoryRleFrame = new Uint8Array([
    0x28, 0xb5, 0x2f, 0xfd, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0b, 0x00,
    0x00, 0x41,
  ])
  let workerCreated = false
  const decoder = createZstdBodyDecoder(() => {
    workerCreated = true
    throw new Error("worker must not be created")
  })

  const error = await decoder
    .decode(contradictoryRleFrame, { maxDecodedBytes: 1024 })
    .catch((caught: unknown) => caught)

  expect(error).toBeInstanceOf(UnsafeZstdFrameError)
  expect(workerCreated).toBeFalse()
})

test("bounded zstd adapter rejects frame content size at cap plus one before decoding", async () => {
  const expected = new TextEncoder().encode('{"ok":true}')
  const compressed = await Bun.zstdCompress(expected)
  let workerCreated = false
  const decoder = createZstdBodyDecoder(() => {
    workerCreated = true
    throw new Error("worker must not be created")
  })

  const error = await decoder
    .decode(compressed, {
      maxDecodedBytes: expected.byteLength - 1,
    })
    .catch((caught: unknown) => caught)

  expect(error).toBeInstanceOf(RequestBodyTooLargeError)
  expect((error as RequestBodyTooLargeError).stage).toBe("decoded")
  expect(workerCreated).toBeFalse()
})

test("bounded zstd adapter rejects an oversized frame window before constructing a decoder", async () => {
  const oversizedWindowHeader = new Uint8Array([
    0x28, 0xb5, 0x2f, 0xfd, 0x00, 0xff,
  ])

  const error = await decodeZstdBody(oversizedWindowHeader, {
    maxDecodedBytes: 64 * 1024 * 1024,
  }).catch((caught: unknown) => caught)

  expect(error).toBeInstanceOf(RequestBodyTooLargeError)
  expect((error as RequestBodyTooLargeError).stage).toBe("decoded")
})

test("bounded zstd adapter fails closed when frame content size is unknown", async () => {
  const unknownContentSizeFrame = new Uint8Array([
    0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x00, 0x01, 0x00, 0x00,
  ])

  const error = await decodeZstdBody(unknownContentSizeFrame, {
    maxDecodedBytes: 1024,
  }).catch((caught: unknown) => caught)

  expect(error).toBeInstanceOf(UnsafeZstdFrameError)
})

test("bounded zstd adapter terminates an active decoder on caller abort", async () => {
  const input = new Uint8Array(16 * 1024 * 1024).fill(65)
  const compressed = await Bun.zstdCompress(input)
  const abortController = new AbortController()
  const operation = startZstdDecode(compressed, {
    maxDecodedBytes: input.byteLength,
    signal: abortController.signal,
  })

  const decoder = await operation.active
  abortController.abort()
  const error = await operation.result.catch((caught: unknown) => caught)
  await operation.closed

  expect(["native", "wasm"]).toContain(decoder)
  expect((error as Error).name).toBe("AbortError")
})

test("bounded zstd adapter closes an active decoder after a checksum failure", async () => {
  const input = new TextEncoder().encode('{"checksum":true}')
  const compressed = zstdCompressSync(input, {
    params: {
      [constants.ZSTD_c_checksumFlag]: 1,
    },
  })
  compressed[compressed.byteLength - 1] ^= 1
  const operation = startZstdDecode(compressed, {
    maxDecodedBytes: input.byteLength,
  })
  const active = operation.active.catch((caught: unknown) => caught)
  const result = operation.result.catch((caught: unknown) => caught)

  await active
  const error = await result
  await operation.closed

  expect(error).toBeInstanceOf(ZstdDecodeError)
})

test("bounded zstd adapter does not create a worker for a pre-aborted request", async () => {
  const input = new TextEncoder().encode('{"ok":true}')
  const compressed = await Bun.zstdCompress(input)
  const abortController = new AbortController()
  abortController.abort()

  expect(() =>
    startZstdDecode(compressed, {
      maxDecodedBytes: input.byteLength,
      signal: abortController.signal,
    }),
  ).toThrow(/operation was aborted/i)
})

test("bounded zstd adapter fails closed when its worker decoder is unavailable", async () => {
  const input = new TextEncoder().encode('{"ok":true}')
  const compressed = await Bun.zstdCompress(input)
  let terminated = false
  const worker = new EventEmitter() as EventEmitter & ZstdWorkerPort
  worker.terminate = () => {
    terminated = true
    return Promise.resolve(0)
  }
  const decoder = createZstdBodyDecoder(() => {
    queueMicrotask(() => {
      worker.emit("message", {
        code: "decoder_unavailable",
        message: "Bounded zstd decoder is unavailable.",
        type: "error",
      })
      worker.emit("message", {
        code: "decoder_unavailable",
        message: "Bounded zstd decoder is unavailable.",
        type: "error",
      })
    })
    return worker
  })
  const operation = decoder.start(compressed, {
    maxDecodedBytes: input.byteLength,
  })
  const active = operation.active.catch((caught: unknown) => caught)
  const result = operation.result.catch((caught: unknown) => caught)

  expect(await active).toBeInstanceOf(ZstdDecoderUnavailableError)
  expect(await result).toBeInstanceOf(ZstdDecoderUnavailableError)
  await operation.closed
  expect(terminated).toBeTrue()
})

test("bounded zstd adapter classifies worker startup failure as unavailable", async () => {
  const input = new TextEncoder().encode('{"ok":true}')
  const compressed = await Bun.zstdCompress(input)
  const decoder = createZstdBodyDecoder(() => {
    throw new Error("worker runtime unavailable")
  })

  expect(() =>
    decoder.start(compressed, { maxDecodedBytes: input.byteLength }),
  ).toThrow(ZstdDecoderUnavailableError)
})

test("bounded zstd adapter cleans up worker errors and unexpected exits", async () => {
  const input = new TextEncoder().encode('{"ok":true}')
  const compressed = await Bun.zstdCompress(input)

  for (const event of ["error", "exit"] as const) {
    const worker = new EventEmitter() as EventEmitter & ZstdWorkerPort
    worker.terminate = () => Promise.resolve(0)
    const decoder = createZstdBodyDecoder(() => {
      queueMicrotask(() => worker.emit(event))
      return worker
    })
    const operation = decoder.start(compressed, {
      maxDecodedBytes: input.byteLength,
    })
    const active = operation.active.catch((caught: unknown) => caught)
    const result = operation.result.catch((caught: unknown) => caught)

    expect(await active).toBeInstanceOf(ZstdDecodeError)
    expect(await result).toBeInstanceOf(ZstdDecodeError)
    await operation.closed
  }
})

test("bounded zstd adapter closes a worker when abort wins the spawn race", async () => {
  const input = new TextEncoder().encode('{"ok":true}')
  const compressed = await Bun.zstdCompress(input)
  const abortController = new AbortController()
  let terminated = false
  const worker = new EventEmitter() as EventEmitter & ZstdWorkerPort
  worker.terminate = () => {
    terminated = true
    return Promise.resolve(0)
  }
  const decoder = createZstdBodyDecoder(() => {
    abortController.abort()
    return worker
  })
  const operation = decoder.start(compressed, {
    maxDecodedBytes: input.byteLength,
    signal: abortController.signal,
  })
  const active = operation.active.catch((caught: unknown) => caught)
  const result = operation.result.catch((caught: unknown) => caught)

  expect(((await active) as Error).name).toBe("AbortError")
  expect(((await result) as Error).name).toBe("AbortError")
  await operation.closed
  expect(terminated).toBeTrue()
})

test("caller abort wins after result arrives but before worker cleanup finishes", async () => {
  const input = new TextEncoder().encode('{"ok":true}')
  const compressed = await Bun.zstdCompress(input)
  const abortController = new AbortController()
  let releaseTerminate: (() => void) | undefined
  let markTerminateStarted: (() => void) | undefined
  const terminateStarted = new Promise<void>((resolve) => {
    markTerminateStarted = resolve
  })
  const worker = new EventEmitter() as EventEmitter & ZstdWorkerPort
  worker.terminate = () => {
    markTerminateStarted?.()
    return new Promise<number>((resolve) => {
      releaseTerminate = () => resolve(0)
    })
  }
  const decoder = createZstdBodyDecoder(() => {
    queueMicrotask(() => {
      worker.emit("message", { decoder: "native", type: "active" })
      worker.emit("message", {
        output: input.slice().buffer,
        type: "result",
      })
    })
    return worker
  })
  const operation = decoder.start(compressed, {
    maxDecodedBytes: input.byteLength,
    signal: abortController.signal,
  })
  const result = operation.result.catch((caught: unknown) => caught)

  await operation.active
  await terminateStarted
  abortController.abort()
  releaseTerminate?.()
  const outcome = await result
  await operation.closed

  expect((outcome as Error).name).toBe("AbortError")
})

test("caller abort wins over worker failures while cleanup is pending", async () => {
  const input = new TextEncoder().encode('{"ok":true}')
  const compressed = await Bun.zstdCompress(input)

  for (const code of ["decoder_unavailable", "invalid_zstd"] as const) {
    const abortController = new AbortController()
    let releaseTerminate: (() => void) | undefined
    let markTerminateStarted: (() => void) | undefined
    const terminateStarted = new Promise<void>((resolve) => {
      markTerminateStarted = resolve
    })
    const worker = new EventEmitter() as EventEmitter & ZstdWorkerPort
    worker.terminate = () => {
      markTerminateStarted?.()
      return new Promise<number>((resolve) => {
        releaseTerminate = () => resolve(0)
      })
    }
    const decoder = createZstdBodyDecoder(() => {
      queueMicrotask(() => {
        worker.emit("message", {
          code,
          message: "worker failed",
          type: "error",
        })
      })
      return worker
    })
    const operation = decoder.start(compressed, {
      maxDecodedBytes: input.byteLength,
      signal: abortController.signal,
    })
    const active = operation.active.catch((caught: unknown) => caught)
    const result = operation.result.catch((caught: unknown) => caught)

    await terminateStarted
    abortController.abort()
    releaseTerminate?.()
    const activeOutcome = await active
    const resultOutcome = await result
    await operation.closed

    expect((activeOutcome as Error).name).toBe("AbortError")
    expect((resultOutcome as Error).name).toBe("AbortError")
  }
})
