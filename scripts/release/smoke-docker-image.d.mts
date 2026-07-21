export interface DockerImageSmokeOptions {
  configDigest: string
  image: string
  timeoutMs?: number
  version: string
}

export interface DockerImageSmokeResult {
  configDigest: string
  health: string
  version: string
}

export function smokeDockerImage(
  options: DockerImageSmokeOptions,
  dependencies?: Record<string, unknown>,
): Promise<DockerImageSmokeResult>

export function runDockerImageSmokeCli(
  arguments_: string[],
  dependencies?: Record<string, unknown>,
): Promise<DockerImageSmokeResult>
