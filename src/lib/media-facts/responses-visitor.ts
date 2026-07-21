import type {
  ResponseInputCodeInterpreterCall,
  ResponseInputComputerCallOutput,
  ResponseInputItem,
  ResponseInputMessage,
  ResponsesPayload,
} from "~/services/copilot/create-responses"

import {
  createDataUrlFact,
  createFileIdFact,
  createInvalidValueFact,
  createRawBase64Fact,
  createUrlOrDataFact,
  getResponsesFileDetail,
  getResponsesImageDetail,
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

const isResponseInputMessage = (
  value: ResponseInputItem,
): value is ResponseInputMessage =>
  isRecord(value)
  && (value.type === undefined || value.type === "message")
  && (value.role === "user"
    || value.role === "assistant"
    || value.role === "system"
    || value.role === "developer")

const isResponseComputerCallOutput = (
  value: ResponseInputItem,
): value is ResponseInputComputerCallOutput =>
  isRecord(value)
  && value.type === "computer_call_output"
  && isRecord(value.output)

const isResponseCodeInterpreterCall = (
  value: ResponseInputItem,
): value is ResponseInputCodeInterpreterCall & {
  outputs: NonNullable<ResponseInputCodeInterpreterCall["outputs"]>
} =>
  isRecord(value)
  && value.type === "code_interpreter_call"
  && Array.isArray(value.outputs)

const consume = (
  collector: FactCollector,
  value: unknown,
  depth: number,
  ancestors: Ancestor,
): boolean => collector.visit(value, depth, ancestors).accepted

const visitResponsesContentBlock = (
  value: Record<string, unknown>,
  path: Array<MediaPathSegment>,
  depth: number,
  ancestors: Ancestor,
  collector: FactCollector,
): void => {
  if (value.type === "input_image") {
    const detail = getResponsesImageDetail(value.detail)
    let found = false
    if (
      typeof value.image_url === "string"
      && consume(collector, value.image_url, depth + 1, ancestors)
    ) {
      found = true
      collector.add(
        createUrlOrDataFact(
          {
            carrier: "responses.input_image.image_url",
            detail,
            mediaKind: "image",
            path: [...path, "image_url"],
            protocol: "responses",
          },
          value.image_url,
          collector.options,
        ),
      )
    }
    if (
      typeof value.file_id === "string"
      && consume(collector, value.file_id, depth + 1, ancestors)
    ) {
      found = true
      collector.add(
        createFileIdFact(
          {
            carrier: "responses.input_image.file_id",
            detail,
            mediaKind: "image",
            path: [...path, "file_id"],
            protocol: "responses",
          },
          value.file_id,
        ),
      )
    }
    if (!found) {
      collector.add(
        createInvalidValueFact({
          carrier: "responses.input_image.image_url",
          detail,
          mediaKind: "image",
          path: [...path, "image_url"],
          protocol: "responses",
        }),
      )
    }
    return
  }

  if (value.type === "input_file") {
    const detail = getResponsesFileDetail(value.detail)
    let found = false
    if (
      typeof value.file_data === "string"
      && consume(collector, value.file_data, depth + 1, ancestors)
    ) {
      found = true
      const factDescriptor: MediaFactDescriptor = {
        carrier: "responses.input_file.file_data",
        detail,
        mediaKind: "file",
        path: [...path, "file_data"],
        protocol: "responses",
      }
      collector.add(
        createDataUrlFact(factDescriptor, value.file_data, collector.options)
          ?? createRawBase64Fact(
            factDescriptor,
            value.file_data,
            undefined,
            collector.options,
          ),
      )
    }
    if (
      typeof value.file_url === "string"
      && consume(collector, value.file_url, depth + 1, ancestors)
    ) {
      found = true
      collector.add(
        createUrlOrDataFact(
          {
            carrier: "responses.input_file.file_url",
            detail,
            mediaKind: "file",
            path: [...path, "file_url"],
            protocol: "responses",
          },
          value.file_url,
          collector.options,
        ),
      )
    }
    if (
      typeof value.file_id === "string"
      && consume(collector, value.file_id, depth + 1, ancestors)
    ) {
      found = true
      collector.add(
        createFileIdFact(
          {
            carrier: "responses.input_file.file_id",
            detail,
            mediaKind: "file",
            path: [...path, "file_id"],
            protocol: "responses",
          },
          value.file_id,
        ),
      )
    }
    if (!found) {
      collector.add(
        createInvalidValueFact({
          carrier: "responses.input_file.file_data",
          detail,
          mediaKind: "file",
          path: [...path, "file_data"],
          protocol: "responses",
        }),
      )
    }
    return
  }
  // The approved 2026-07-21 Responses contract baseline does not include an
  // input_audio carrier. Keep unknown content opaque instead of shape-matching.
}

const visitResponsesContent = (
  content: Array<unknown>,
  path: Array<MediaPathSegment>,
  depth: number,
  ancestors: Ancestor,
  collector: FactCollector,
): void => {
  const contentVisit = collector.visit(content, depth, ancestors)
  if (!contentVisit.ancestor) return
  for (let index = 0; index < content.length && !collector.halted; index += 1) {
    const block = content[index]
    const blockVisit = collector.visit(block, depth + 1, contentVisit.ancestor)
    if (!blockVisit.accepted || !isRecord(block) || !blockVisit.ancestor)
      continue
    visitResponsesContentBlock(
      block,
      [...path, index],
      depth + 1,
      blockVisit.ancestor,
      collector,
    )
  }
}

const visitResponsesHistoryItem = (
  item: ResponseInputItem,
  path: Array<MediaPathSegment>,
  depth: number,
  ancestors: Ancestor,
  collector: FactCollector,
): void => {
  if (isResponseComputerCallOutput(item)) {
    const outputVisit = collector.visit(item.output, depth, ancestors)
    if (!outputVisit.ancestor || item.output.type !== "computer_screenshot")
      return
    if (
      typeof item.output.image_url === "string"
      && consume(
        collector,
        item.output.image_url,
        depth + 1,
        outputVisit.ancestor,
      )
    ) {
      collector.add(
        createUrlOrDataFact(
          {
            carrier: "responses.computer_call_output.output.image_url",
            mediaKind: "image",
            path: [...path, "output", "image_url"],
            protocol: "responses",
          },
          item.output.image_url,
          collector.options,
        ),
      )
    } else if (
      typeof item.output.file_id === "string"
      && consume(
        collector,
        item.output.file_id,
        depth + 1,
        outputVisit.ancestor,
      )
    ) {
      collector.add(
        createFileIdFact(
          {
            carrier: "responses.computer_call_output.output.file_id",
            mediaKind: "image",
            path: [...path, "output", "file_id"],
            protocol: "responses",
          },
          item.output.file_id,
        ),
      )
    } else {
      collector.add(
        createInvalidValueFact({
          carrier: "responses.computer_call_output.output.image_url",
          mediaKind: "image",
          path: [...path, "output", "image_url"],
          protocol: "responses",
        }),
      )
    }
    return
  }

  if (
    item.type === "image_generation_call"
    && typeof item.result === "string"
    && consume(collector, item.result, depth, ancestors)
  ) {
    collector.add(
      createRawBase64Fact(
        {
          carrier: "responses.image_generation_call.result",
          mediaKind: "image",
          path: [...path, "result"],
          protocol: "responses",
        },
        item.result,
        undefined,
        collector.options,
      ),
    )
    return
  }

  if (!isResponseCodeInterpreterCall(item)) return
  const outputsVisit = collector.visit(item.outputs, depth, ancestors)
  if (!outputsVisit.ancestor) return
  for (
    let index = 0;
    index < item.outputs.length && !collector.halted;
    index += 1
  ) {
    const output = item.outputs[index]
    const outputVisit = collector.visit(
      output,
      depth + 1,
      outputsVisit.ancestor,
    )
    if (!outputVisit.accepted || !isRecord(output) || !outputVisit.ancestor) {
      continue
    }
    if (output.type !== "image") continue
    if (
      typeof output.url === "string"
      && consume(collector, output.url, depth + 2, outputVisit.ancestor)
    ) {
      collector.add(
        createUrlOrDataFact(
          {
            carrier: "responses.code_interpreter_call.outputs.image.url",
            mediaKind: "image",
            path: [...path, "outputs", index, "url"],
            protocol: "responses",
          },
          output.url,
          collector.options,
        ),
      )
    } else {
      collector.add(
        createInvalidValueFact({
          carrier: "responses.code_interpreter_call.outputs.image.url",
          mediaKind: "image",
          path: [...path, "outputs", index, "url"],
          protocol: "responses",
        }),
      )
    }
  }
}

export const collectResponsesMediaFacts = (
  root: Record<string, unknown>,
  rootAncestor: Ancestor,
  collector: FactCollector,
): void => {
  if (!Array.isArray(root.input)) return
  const payload = root as unknown as ResponsesPayload
  const input = payload.input as Array<ResponseInputItem>
  const inputVisit = collector.visit(input, 1, rootAncestor)
  if (!inputVisit.ancestor) return
  for (let index = 0; index < input.length && !collector.halted; index += 1) {
    const item = input[index]
    const itemVisit = collector.visit(item, 2, inputVisit.ancestor)
    if (!itemVisit.accepted || !isRecord(item) || !itemVisit.ancestor) continue
    const path: Array<MediaPathSegment> = ["input", index]
    visitResponsesHistoryItem(item, path, 3, itemVisit.ancestor, collector)
    if (isResponseInputMessage(item) && Array.isArray(item.content)) {
      visitResponsesContent(
        item.content,
        [...path, "content"],
        3,
        itemVisit.ancestor,
        collector,
      )
    } else if (
      item.type === "function_call_output"
      && Array.isArray(item.output)
    ) {
      visitResponsesContent(
        item.output,
        [...path, "output"],
        3,
        itemVisit.ancestor,
        collector,
      )
    }
  }
}
