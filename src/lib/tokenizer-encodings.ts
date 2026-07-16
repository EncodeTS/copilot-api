export const ENCODING_MAP = {
  o200k_base: () => import("gpt-tokenizer/encoding/o200k_base"),
  cl100k_base: () => import("gpt-tokenizer/encoding/cl100k_base"),
  p50k_base: () => import("gpt-tokenizer/encoding/p50k_base"),
  p50k_edit: () => import("gpt-tokenizer/encoding/p50k_edit"),
  r50k_base: () => import("gpt-tokenizer/encoding/r50k_base"),
} as const

export type SupportedEncoding = keyof typeof ENCODING_MAP

export const isSupportedEncoding = (
  encoding: string,
): encoding is SupportedEncoding => encoding in ENCODING_MAP
