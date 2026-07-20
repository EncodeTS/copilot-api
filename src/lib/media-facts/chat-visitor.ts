import type {
  ChatCompletionsPayload,
  Message,
} from "~/services/copilot/create-chat-completions"

import {
  createAudioIdFact,
  createDataUrlFact,
  createFileIdFact,
  createInvalidValueFact,
  createRawBase64Fact,
  createUrlOrDataFact,
  getAudioMimeType,
  getChatImageDetail,
} from "~/lib/media-facts/fact-builders"
import {
  type Ancestor,
  FactCollector,
  isRecord,
} from "~/lib/media-facts/collector"
import type {
  MediaFactDescriptor,
  MediaPathSegment,
} from "~/lib/media-facts/types"

const isChatMessage = (value: unknown): value is Message =>
  isRecord(value) && typeof value.role === "string"

const consume = (
  collector: FactCollector,
  value: unknown,
  depth: number,
  ancestors: Ancestor,
): boolean => collector.visit(value, depth, ancestors).accepted

const visitChatContentBlock = (
  value: Record<string, unknown>,
  path: Array<MediaPathSegment>,
  depth: number,
  ancestors: Ancestor,
  collector: FactCollector,
): void => {
  if (value.type === "image_url") {
    const imageUrl = isRecord(value.image_url) ? value.image_url : undefined
    const factDescriptor: MediaFactDescriptor = {
      carrier: "chat.image_url.url",
      detail: getChatImageDetail(imageUrl?.detail),
      mediaKind: "image",
      path: [...path, "image_url", "url"],
      protocol: "chat",
    }
    if (
      typeof imageUrl?.url === "string"
      && consume(collector, imageUrl.url, depth + 1, ancestors)
    ) {
      collector.add(createUrlOrDataFact(factDescriptor, imageUrl.url))
    } else {
      collector.add(createInvalidValueFact(factDescriptor))
    }
    return
  }

  if (value.type === "file") {
    const file = isRecord(value.file) ? value.file : undefined
    if (!file) {
      collector.warn("invalid_container")
      return
    }
    const hasFileDataKey = Object.hasOwn(file, "file_data")
    const hasFileIdKey = Object.hasOwn(file, "file_id")
    const fileData = file?.file_data
    const fileId = file?.file_id
    const hasFileData = typeof fileData === "string"
    const hasFileId = typeof fileId === "string"
    if (
      hasFileDataKey === hasFileIdKey
      || (hasFileDataKey && !hasFileData)
      || (hasFileIdKey && !hasFileId)
    ) {
      if (hasFileData) {
        consume(collector, fileData, depth + 1, ancestors)
        consume(collector, fileId, depth + 1, ancestors)
      }
      collector.warn("invalid_container")
      return
    }
    if (hasFileData) {
      if (!consume(collector, fileData, depth + 1, ancestors)) return
      const factDescriptor: MediaFactDescriptor = {
        carrier: "chat.file.file_data",
        mediaKind: "file",
        path: [...path, "file", "file_data"],
        protocol: "chat",
      }
      collector.add(
        createDataUrlFact(factDescriptor, fileData)
          ?? createRawBase64Fact(factDescriptor, fileData),
      )
    } else if (hasFileId) {
      if (!consume(collector, fileId, depth + 1, ancestors)) return
      collector.add(
        createFileIdFact(
          {
            carrier: "chat.file.file_id",
            mediaKind: "file",
            path: [...path, "file", "file_id"],
            protocol: "chat",
          },
          fileId,
        ),
      )
    }
    return
  }

  if (value.type !== "input_audio") return
  const inputAudio = isRecord(value.input_audio) ? value.input_audio : undefined
  if (
    typeof inputAudio?.data === "string"
    && consume(collector, inputAudio.data, depth + 1, ancestors)
  ) {
    collector.add(
      createRawBase64Fact(
        {
          carrier: "chat.input_audio.data",
          mediaKind: "audio",
          path: [...path, "input_audio", "data"],
          protocol: "chat",
        },
        inputAudio.data,
        getAudioMimeType(inputAudio.format),
      ),
    )
  } else {
    collector.add(
      createInvalidValueFact({
        carrier: "chat.input_audio.data",
        mediaKind: "audio",
        path: [...path, "input_audio", "data"],
        protocol: "chat",
      }),
    )
  }
}

export const collectChatMediaFacts = (
  root: Record<string, unknown>,
  rootAncestor: Ancestor,
  collector: FactCollector,
): void => {
  if (!Array.isArray(root.messages)) return
  const payload = root as unknown as ChatCompletionsPayload
  const messagesVisit = collector.visit(payload.messages, 1, rootAncestor)
  if (!messagesVisit.ancestor) return
  for (
    let messageIndex = 0;
    messageIndex < payload.messages.length && !collector.halted;
    messageIndex += 1
  ) {
    const message = payload.messages[messageIndex]
    const messageVisit = collector.visit(message, 2, messagesVisit.ancestor)
    if (
      !messageVisit.accepted
      || !isChatMessage(message)
      || !messageVisit.ancestor
    ) {
      continue
    }
    const messagePath: Array<MediaPathSegment> = ["messages", messageIndex]
    if (message.role === "user" && Array.isArray(message.content)) {
      const contentVisit = collector.visit(
        message.content,
        3,
        messageVisit.ancestor,
      )
      if (contentVisit.ancestor) {
        for (
          let contentIndex = 0;
          contentIndex < message.content.length && !collector.halted;
          contentIndex += 1
        ) {
          const block = message.content[contentIndex]
          const blockVisit = collector.visit(block, 4, contentVisit.ancestor)
          if (
            !blockVisit.accepted
            || !isRecord(block)
            || !blockVisit.ancestor
          ) {
            continue
          }
          visitChatContentBlock(
            block,
            [...messagePath, "content", contentIndex],
            4,
            blockVisit.ancestor,
            collector,
          )
        }
      }
    } else if (message.role === "user" && message.content !== undefined) {
      collector.visit(message.content, 3, messageVisit.ancestor)
    }
    if (
      message.role === "assistant"
      && isRecord(message.audio)
      && typeof message.audio.id === "string"
    ) {
      const audioVisit = collector.visit(
        message.audio,
        3,
        messageVisit.ancestor,
      )
      if (
        audioVisit.ancestor
        && consume(collector, message.audio.id, 4, audioVisit.ancestor)
      ) {
        collector.add(
          createAudioIdFact([...messagePath, "audio", "id"], message.audio.id),
        )
      }
    }
  }
}
