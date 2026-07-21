import { describe, expect, test } from "bun:test"

import {
  collectMediaFacts,
  MEDIA_IMAGE_PROBE_MAX_BYTES,
  type MediaFact,
} from "~/lib/media-facts"

import {
  imageDataUrl,
  makeCorruptWebp,
  makeGif,
  makeJpeg,
  makeLargeAnimatedWebp,
  makePng,
  makeVp8lWebp,
  makeVp8Webp,
  makeWebp,
  pngChunk,
  responsesImagePayload,
} from "./media-facts-fixtures"

const imageFact = (buffer: Buffer, mimeType: string): MediaFact => {
  const result = collectMediaFacts(responsesImagePayload(buffer, mimeType), {
    protocol: "responses",
  })
  const fact = result.facts[0]
  if (!fact) throw new Error("Expected image fact")
  return fact
}

describe("media image metadata", () => {
  test("can inventory exact Base64 bytes without allocating an image-header probe", () => {
    let base64Decodes = 0
    const result = collectMediaFacts(
      responsesImagePayload(makePng(32, 24), "image/png"),
      {
        onBase64Decode: () => {
          base64Decodes += 1
        },
        probeImageHeaders: false,
        protocol: "responses",
      },
    )

    expect(base64Decodes).toBe(0)
    expect(result.facts[0]?.base64?.decodedBytes).toBeGreaterThan(0)
    expect(result.facts[0]?.image).toBeUndefined()
  })

  test("probes PNG, JPEG, GIF, and WebP dimensions and frame counts", () => {
    const png = makePng(320, 240, { frames: 3 })
    const jpeg = makeJpeg(772, 258)
    const gif = makeGif(40, 30, 2)
    const webp = makeWebp(640, 480, 4)
    const facts = [
      imageFact(png, "image/png"),
      imageFact(jpeg, "image/jpeg"),
      imageFact(gif, "image/gif"),
      imageFact(webp, "image/webp"),
    ]

    expect(facts.map((fact) => fact.image)).toEqual([
      {
        format: "png",
        frameCount: 3,
        frameCountExact: true,
        height: 240,
        probedBytes: 61,
        width: 320,
      },
      {
        format: "jpeg",
        frameCount: 1,
        frameCountExact: true,
        height: 258,
        probedBytes: 11,
        width: 772,
      },
      {
        format: "gif",
        frameCount: 2,
        frameCountExact: true,
        height: 30,
        probedBytes: gif.byteLength,
        width: 40,
      },
      {
        format: "webp",
        frameCount: 4,
        frameCountExact: true,
        height: 480,
        probedBytes: 124,
        width: 640,
      },
    ])
    expect(facts.map((fact) => fact.warnings)).toEqual([[], [], [], []])
  })

  test("probes static PNG plus native VP8 and VP8L WebP headers", () => {
    const facts = [
      imageFact(makePng(9, 7), "image/png"),
      imageFact(makeVp8Webp(511, 257), "image/webp"),
      imageFact(makeVp8lWebp(12_345, 4_321), "image/webp"),
    ]

    expect(
      facts.map((fact) => ({
        format: fact.image?.format,
        frames: fact.image?.frameCount,
        height: fact.image?.height,
        width: fact.image?.width,
      })),
    ).toEqual([
      { format: "png", frames: 1, height: 7, width: 9 },
      { format: "webp", frames: 1, height: 257, width: 511 },
      { format: "webp", frames: 1, height: 4_321, width: 12_345 },
    ])
  })

  test("reads PNG metadata before a large IDAT body exceeds the probe prefix", () => {
    const png = makePng(2_048, 1_024, {
      idatBytes: MEDIA_IMAGE_PROBE_MAX_BYTES + 32_768,
    })
    const fact = imageFact(png, "image/png")

    expect(fact.base64?.decodedBytes).toBe(png.byteLength)
    expect(fact.image).toEqual({
      format: "png",
      frameCount: 1,
      frameCountExact: true,
      height: 1_024,
      probedBytes: 41,
      width: 2_048,
    })
    expect(fact.warnings).toEqual([])
  })

  test("reads VP8 dimensions without buffering the large compressed chunk", () => {
    const webp = makeVp8Webp(1_920, 1_080, MEDIA_IMAGE_PROBE_MAX_BYTES + 65_536)
    const fact = imageFact(webp, "image/webp")

    expect(fact.base64?.decodedBytes).toBe(webp.byteLength)
    expect(fact.image).toEqual({
      format: "webp",
      frameCount: 1,
      frameCountExact: true,
      height: 1_080,
      probedBytes: 30,
      width: 1_920,
    })
    expect(fact.warnings).toEqual([])
  })

  test("returns bounded partial metadata when a large chunk hides later frames", () => {
    const basePng = makePng(80, 60)
    const png = Buffer.concat([
      basePng.subarray(0, 33),
      pngChunk("iCCP", Buffer.alloc(MEDIA_IMAGE_PROBE_MAX_BYTES + 1_024)),
      basePng.subarray(33),
    ])
    const webp = makeLargeAnimatedWebp(
      800,
      600,
      MEDIA_IMAGE_PROBE_MAX_BYTES + 1_024,
    )
    const facts = [imageFact(png, "image/png"), imageFact(webp, "image/webp")]

    expect(
      facts.map((fact) => ({
        exact: fact.image?.frameCountExact,
        format: fact.image?.format,
        height: fact.image?.height,
        warnings: fact.warnings,
        width: fact.image?.width,
      })),
    ).toEqual([
      {
        exact: false,
        format: "png",
        height: 60,
        warnings: ["image_probe_limit_reached"],
        width: 80,
      },
      {
        exact: false,
        format: "webp",
        height: 600,
        warnings: ["image_probe_limit_reached"],
        width: 800,
      },
    ])
  })

  test("bounds animated frame scanning while retaining exact decoded length", () => {
    const totalFrames = 20_000
    const gif = makeGif(8, 6, totalFrames)
    const fact = imageFact(gif, "image/gif")

    expect(fact.base64?.decodedBytes).toBe(gif.byteLength)
    expect(fact.image?.probedBytes).toBeLessThanOrEqual(
      MEDIA_IMAGE_PROBE_MAX_BYTES,
    )
    expect(fact.image?.frameCount).toBeGreaterThan(0)
    expect(fact.image?.frameCount).toBeLessThan(totalFrames)
    expect(fact.image?.frameCountExact).toBe(false)
    expect(fact.warnings).toEqual(["image_probe_limit_reached"])
  })

  test("distinguishes truncated, corrupt, mismatched, and unknown image data", () => {
    const truncatedPng = makePng(32, 16).subarray(0, 24)
    const jpegAsPng = makeJpeg(12, 8)
    const inputs = [
      imageFact(truncatedPng, "image/png"),
      imageFact(makeCorruptWebp(), "image/webp"),
      imageFact(jpegAsPng, "image/png"),
      imageFact(Buffer.from([1, 2, 3, 4]), "image/avif"),
    ]

    expect(
      inputs.map((fact) => ({
        format: fact.image?.format,
        warnings: fact.warnings,
      })),
    ).toEqual([
      { format: undefined, warnings: ["invalid_image_header"] },
      { format: undefined, warnings: ["invalid_image_header"] },
      { format: "jpeg", warnings: ["mime_format_mismatch"] },
      {
        format: undefined,
        warnings: ["unknown_image_format", "unsupported_mime_type"],
      },
    ])
  })

  test("does not retain the Base64 data URL while probing", () => {
    const png = makePng(2, 2)
    const raw = imageDataUrl(png, "image/png")
    const result = collectMediaFacts(
      {
        input: [
          {
            content: [{ detail: "auto", image_url: raw, type: "input_image" }],
            role: "user",
            type: "message",
          },
        ],
      },
      { protocol: "responses" },
    )

    expect(JSON.stringify(result)).not.toContain(raw)
    expect(JSON.stringify(result)).not.toContain(png.toString("base64"))
  })
})
