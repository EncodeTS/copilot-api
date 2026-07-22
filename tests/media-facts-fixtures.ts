import type { ResponsesPayload } from "~/services/copilot/create-responses"

export const pngChunk = (type: string, data: Buffer): Buffer => {
  const header = Buffer.alloc(8)
  header.writeUInt32BE(data.byteLength, 0)
  header.write(type, 4, 4, "ascii")
  return Buffer.concat([header, data, Buffer.alloc(4)])
}

export const makePng = (
  width: number,
  height: number,
  options: { frames?: number; idatBytes?: number } = {},
): Buffer => {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const chunks = [pngChunk("IHDR", ihdr)]
  const frames = options.frames ?? 1
  if (frames > 1) {
    const animationControl = Buffer.alloc(8)
    animationControl.writeUInt32BE(frames, 0)
    chunks.push(pngChunk("acTL", animationControl))
  }
  chunks.push(pngChunk("IDAT", Buffer.alloc(options.idatBytes ?? 1)))
  chunks.push(pngChunk("IEND", Buffer.alloc(0)))
  return Buffer.concat([signature, ...chunks])
}

export const makeJpeg = (width: number, height: number): Buffer => {
  const startOfFrame = Buffer.alloc(11)
  startOfFrame.writeUInt16BE(11, 0)
  startOfFrame[2] = 8
  startOfFrame.writeUInt16BE(height, 3)
  startOfFrame.writeUInt16BE(width, 5)
  startOfFrame[7] = 1
  startOfFrame[8] = 1
  startOfFrame[9] = 0x11
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xc0]),
    startOfFrame,
    Buffer.from([0xff, 0xd9]),
  ])
}

export const makeGif = (
  width: number,
  height: number,
  frames: number,
): Buffer => {
  const header = Buffer.alloc(13)
  header.write("GIF89a", 0, "ascii")
  header.writeUInt16LE(width, 6)
  header.writeUInt16LE(height, 8)
  const frame = Buffer.from([
    0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 0x01, 0,
  ])
  return Buffer.concat([
    header,
    ...Array.from({ length: frames }, () => frame),
    Buffer.from([0x3b]),
  ])
}

const writeUInt24LE = (buffer: Buffer, value: number, offset: number): void => {
  buffer[offset] = value & 0xff
  buffer[offset + 1] = (value >> 8) & 0xff
  buffer[offset + 2] = (value >> 16) & 0xff
}

export const webpChunk = (type: string, data: Buffer): Buffer => {
  const header = Buffer.alloc(8)
  header.write(type, 0, 4, "ascii")
  header.writeUInt32LE(data.byteLength, 4)
  return Buffer.concat([
    header,
    data,
    ...(data.byteLength % 2 === 0 ? [] : [Buffer.alloc(1)]),
  ])
}

export const wrapWebp = (...chunks: Array<Buffer>): Buffer => {
  const body = Buffer.concat([Buffer.from("WEBP", "ascii"), ...chunks])
  const riff = Buffer.alloc(8)
  riff.write("RIFF", 0, 4, "ascii")
  riff.writeUInt32LE(body.byteLength, 4)
  return Buffer.concat([riff, body])
}

export const makeWebp = (
  width: number,
  height: number,
  frames: number,
): Buffer => {
  const extended = Buffer.alloc(10)
  extended[0] = frames > 1 ? 0x02 : 0
  writeUInt24LE(extended, width - 1, 4)
  writeUInt24LE(extended, height - 1, 7)
  const chunks = [webpChunk("VP8X", extended)]
  if (frames > 1) {
    chunks.push(webpChunk("ANIM", Buffer.alloc(6)))
    for (let index = 0; index < frames; index += 1) {
      chunks.push(webpChunk("ANMF", Buffer.alloc(16)))
    }
  }
  return wrapWebp(...chunks)
}

export const makeLargeAnimatedWebp = (
  width: number,
  height: number,
  frameBytes: number,
): Buffer => {
  const extended = Buffer.alloc(10)
  extended[0] = 0x02
  writeUInt24LE(extended, width - 1, 4)
  writeUInt24LE(extended, height - 1, 7)
  return wrapWebp(
    webpChunk("VP8X", extended),
    webpChunk("ANIM", Buffer.alloc(6)),
    webpChunk("ANMF", Buffer.alloc(Math.max(16, frameBytes))),
  )
}

export const makeVp8Webp = (
  width: number,
  height: number,
  payloadBytes = 10,
): Buffer => {
  const payload = Buffer.alloc(Math.max(10, payloadBytes))
  payload.set([0x9d, 0x01, 0x2a], 3)
  payload.writeUInt16LE(width, 6)
  payload.writeUInt16LE(height, 8)
  return wrapWebp(webpChunk("VP8 ", payload))
}

export const makeVp8lWebp = (width: number, height: number): Buffer => {
  const encodedWidth = width - 1
  const encodedHeight = height - 1
  const payload = Buffer.alloc(5)
  payload[0] = 0x2f
  payload[1] = encodedWidth & 0xff
  payload[2] = ((encodedWidth >> 8) & 0x3f) | ((encodedHeight & 0x03) << 6)
  payload[3] = (encodedHeight >> 2) & 0xff
  payload[4] = (encodedHeight >> 10) & 0x0f
  return wrapWebp(webpChunk("VP8L", payload))
}

export const makeCorruptWebp = (): Buffer => {
  const extended = Buffer.alloc(10)
  writeUInt24LE(extended, 19, 4)
  writeUInt24LE(extended, 9, 7)
  const invalidChunkHeader = Buffer.alloc(8)
  invalidChunkHeader.write("JUNK", 0, 4, "ascii")
  invalidChunkHeader.writeUInt32LE(100, 4)
  return wrapWebp(webpChunk("VP8X", extended), invalidChunkHeader)
}

export const imageDataUrl = (buffer: Buffer, mimeType: string): string =>
  `data:${mimeType};base64,${buffer.toString("base64")}`

export const responsesImagePayload = (
  buffer: Buffer,
  mimeType: string,
  detail: "auto" | "high" | "low" | "original" = "auto",
): ResponsesPayload => {
  const payload = {
    input: [
      {
        content: [
          {
            detail,
            image_url: imageDataUrl(buffer, mimeType),
            type: "input_image",
          },
        ],
        role: "user",
        type: "message",
      },
    ],
    model: "gpt-test",
  } satisfies ResponsesPayload
  return payload
}
