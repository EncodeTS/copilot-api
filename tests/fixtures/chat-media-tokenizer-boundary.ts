import type { ChatCompletionsPayload } from "../../src/services/copilot/create-chat-completions"
import {
  closeIdleTokenizerWorker,
  tokenizerWorkerClientDependencies,
  type TokenizerWorkerTransport,
} from "../../src/lib/tokenizer-worker-client"
import { getTokenCount } from "../../src/lib/tokenizer"

const mediaSecrets = {
  audio: "U0VDUkVUX0FVRElP".repeat(2_000),
  audioId: "audio_secret_123",
  fileData: `data:application/pdf;base64,${"U0VDUkVUX0ZJTEU=".repeat(2_000)}`,
  fileId: "file_secret_123",
  imageData: `data:image/png;base64,${"U0VDUkVUX0lNQUdF".repeat(2_000)}`,
  imageUrl: "https://private.example.test/image.png?secret=media_secret_123",
  malformedAudio: "MALFORMED_AUDIO_SECRET".repeat(2_000),
}

const payload = {
  messages: [
    {
      content: [
        { text: "x".repeat(16_500), type: "text" },
        {
          image_url: { url: mediaSecrets.imageUrl },
          type: "image_url",
        },
        {
          image_url: { url: mediaSecrets.imageData },
          type: "image_url",
        },
        {
          file: { file_data: mediaSecrets.fileData, filename: "report.pdf" },
          type: "file",
        },
        {
          file: { file_id: mediaSecrets.fileId, filename: "stored.pdf" },
          type: "file",
        },
        {
          input_audio: { data: mediaSecrets.audio, format: "wav" },
          type: "input_audio",
        },
      ],
      role: "user",
    },
    {
      audio: { id: mediaSecrets.audioId },
      content: "done",
      role: "assistant",
    },
    {
      audio: mediaSecrets.malformedAudio,
      content: "malformed string audio",
      role: "assistant",
    },
    {
      audio: { id: 42 },
      content: "malformed object audio",
      role: "assistant",
    },
  ],
  model: "gpt-5",
} as unknown as ChatCompletionsPayload

class RecordingWorker implements TokenizerWorkerTransport {
  readonly texts = new Array<string>()
  private messageListener: ((value: unknown) => void) | undefined

  onError(): void {}

  onExit(): void {}

  onMessage(listener: (value: unknown) => void): void {
    this.messageListener = listener
  }

  postMessage(value: unknown): void {
    const request = value as { id: number; texts: Array<string> }
    this.texts.push(...request.texts)
    queueMicrotask(() => {
      this.messageListener?.({
        counts: request.texts.map(() => 1),
        id: request.id,
      })
    })
  }

  terminate(): Promise<number> {
    return Promise.resolve(0)
  }

  unref(): void {}
}

const worker = new RecordingWorker()
tokenizerWorkerClientDependencies.createWorker = () => worker

try {
  const model = {
    capabilities: { tokenizer: "o200k_base" },
    id: "gpt-5",
  } as Parameters<typeof getTokenCount>[1]
  const withoutMedia = await getTokenCount(
    { messages: [{ content: [], role: "user" }], model: "gpt-5" },
    model,
  )
  const withMalformedMedia = await getTokenCount(
    {
      messages: [
        {
          content: [{ image_url: { url: 42 }, type: "image_url" }],
          role: "user",
        },
      ],
      model: "gpt-5",
    } as unknown as ChatCompletionsPayload,
    model,
  )
  const withMalformedFile = await getTokenCount(
    {
      messages: [
        {
          content: [
            {
              file: { file_data: "invalid", file_id: "also-invalid" },
              type: "file",
            },
          ],
          role: "user",
        },
      ],
      model: "gpt-5",
    } as unknown as ChatCompletionsPayload,
    model,
  )
  const result = await getTokenCount(payload, model, {
    signal: new AbortController().signal,
  })
  const encodedText = worker.texts.join("\n")
  console.log(
    JSON.stringify({
      encodedText,
      malformedMediaTokens: withMalformedMedia.input - withoutMedia.input,
      malformedFileTokens: withMalformedFile.input - withoutMedia.input,
      result,
      secretSeen: Object.values(mediaSecrets).some((secret) =>
        encodedText.includes(secret),
      ),
    }),
  )
} finally {
  await closeIdleTokenizerWorker()
}
