export interface IsolatedRuntimeEnvironment {
  environment: NodeJS.ProcessEnv
  root: string
}

export interface ZstdWorkerContractOptions {
  decoderPreference?: "auto" | "wasm"
  environment?: NodeJS.ProcessEnv
  workerUrl: URL
}

export interface ZstdWorkerContractResult {
  capPlusOneFailedClosed: boolean
  capZeroRejectedNonEmpty: boolean
  decodedBytes: number
  decoder: "native" | "wasm" | "zero"
  emptyDecodedBytes: number
  maxEmittedChunkBytes: number
  workerIsolatedEnvironment: boolean
}

export function createIsolatedRuntimeEnvironment(
  label?: string,
): IsolatedRuntimeEnvironment

export function runZstdWorkerContract(
  options: ZstdWorkerContractOptions,
): Promise<ZstdWorkerContractResult>
