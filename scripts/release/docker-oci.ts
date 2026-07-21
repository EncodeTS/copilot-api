#!/usr/bin/env bun

import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { parseArgs } from "node:util"

type DockerPlatform = "linux/amd64" | "linux/arm64"

interface OciDescriptor {
  digest?: string
  mediaType?: string
  platform?: { architecture?: string; os?: string }
  size?: number
}

interface OciIndex {
  manifests?: OciDescriptor[]
  schemaVersion?: number
}

interface OciManifest {
  config?: OciDescriptor
  layers?: OciDescriptor[]
  schemaVersion?: number
}

interface OciConfig {
  architecture?: string
  config?: { Labels?: Record<string, string> }
  os?: string
}

export interface VerifiedDockerOciDescriptor {
  configDigest: string
  manifestDigest: string
  platform: DockerPlatform
  version: string
}

interface BuildxMetadata {
  "containerimage.config.digest"?: unknown
  "containerimage.descriptor"?: OciDescriptor
}

const digestPattern = /^sha256:[0-9a-f]{64}$/u

function sha256(contents: string | Buffer): string {
  return `sha256:${createHash("sha256").update(contents).digest("hex")}`
}

function readJson<T>(filePath: string): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T
  } catch (error) {
    throw new Error(
      `cannot parse ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function blobPath(layout: string, digest: string): string {
  if (!digestPattern.test(digest)) {
    throw new Error(`invalid OCI digest ${JSON.stringify(digest)}`)
  }
  return path.join(layout, "blobs", "sha256", digest.slice("sha256:".length))
}

function readVerifiedBlob(layout: string, descriptor: OciDescriptor): Buffer {
  if (!descriptor.digest) throw new Error("OCI descriptor has no digest")
  const filePath = blobPath(layout, descriptor.digest)
  const contents = fs.readFileSync(filePath)
  if (sha256(contents) !== descriptor.digest) {
    throw new Error(`OCI blob digest mismatch for ${descriptor.digest}`)
  }
  if (
    descriptor.size !== undefined
    && descriptor.size !== contents.byteLength
  ) {
    throw new Error(`OCI blob size mismatch for ${descriptor.digest}`)
  }
  return contents
}

function descriptorPlatform(descriptor: OciDescriptor): string | undefined {
  const { architecture, os } = descriptor.platform ?? {}
  return architecture && os ? `${os}/${architecture}` : undefined
}

export function verifyOciLayout(options: {
  layout: string
  platform: DockerPlatform
  version: string
}): VerifiedDockerOciDescriptor {
  const layout = path.resolve(options.layout)
  const layoutVersion = readJson<{ imageLayoutVersion?: string }>(
    path.join(layout, "oci-layout"),
  )
  if (layoutVersion.imageLayoutVersion !== "1.0.0") {
    throw new Error("OCI layout version must be 1.0.0")
  }

  const indexPath = path.join(layout, "index.json")
  const indexContents = fs.readFileSync(indexPath)
  const index = JSON.parse(indexContents.toString("utf8")) as OciIndex
  if (index.schemaVersion !== 2 || !Array.isArray(index.manifests)) {
    throw new Error("OCI index is malformed")
  }
  const platformManifests = index.manifests.filter(
    (descriptor) =>
      descriptor.mediaType === "application/vnd.oci.image.manifest.v1+json"
      && descriptorPlatform(descriptor) === options.platform,
  )
  if (platformManifests.length !== 1 || index.manifests.length !== 1) {
    throw new Error(
      `OCI layout must contain exactly one ${options.platform} image manifest`,
    )
  }

  const manifestDescriptor = platformManifests[0]
  const manifest = JSON.parse(
    readVerifiedBlob(layout, manifestDescriptor).toString("utf8"),
  ) as OciManifest
  if (
    manifest.schemaVersion !== 2
    || !manifest.config?.digest
    || !Array.isArray(manifest.layers)
  ) {
    throw new Error("OCI image manifest is malformed")
  }
  const config = JSON.parse(
    readVerifiedBlob(layout, manifest.config).toString("utf8"),
  ) as OciConfig
  const [expectedOs, expectedArchitecture] = options.platform.split("/")
  if (
    config.os !== expectedOs
    || config.architecture !== expectedArchitecture
  ) {
    throw new Error("OCI image config platform does not match its descriptor")
  }
  if (
    config.config?.Labels?.["org.opencontainers.image.version"]
    !== options.version
  ) {
    throw new Error("OCI image version label does not match the release")
  }
  for (const layer of manifest.layers) {
    readVerifiedBlob(layout, layer)
  }

  return {
    configDigest: manifest.config.digest,
    manifestDigest: manifestDescriptor.digest!,
    platform: options.platform,
    version: options.version,
  }
}

function verifyBuildxMetadata(
  metadata: BuildxMetadata,
  verified: VerifiedDockerOciDescriptor,
  manifestDescriptor: OciDescriptor,
): void {
  const descriptor = metadata["containerimage.descriptor"]
  if (
    descriptor?.digest !== verified.manifestDigest
    || descriptor.mediaType !== manifestDescriptor.mediaType
    || descriptor.size !== manifestDescriptor.size
  ) {
    throw new Error(
      "BuildKit containerimage.descriptor does not match the OCI manifest descriptor",
    )
  }
  if (metadata["containerimage.config.digest"] !== verified.configDigest) {
    throw new Error(
      "BuildKit containerimage.config.digest does not match the OCI config",
    )
  }
}

function layoutManifestDescriptor(layout: string): OciDescriptor {
  const index = readJson<OciIndex>(path.join(layout, "index.json"))
  if (!Array.isArray(index.manifests) || index.manifests.length !== 1) {
    throw new Error("OCI layout must expose exactly one manifest descriptor")
  }
  return index.manifests[0]
}

function readAndVerifyArtifact(
  directory: string,
  architecture: "amd64" | "arm64",
  version: string,
): VerifiedDockerOciDescriptor {
  const artifactDirectory = path.join(directory, architecture)
  const recorded = readJson<VerifiedDockerOciDescriptor>(
    path.join(artifactDirectory, "descriptor.json"),
  )
  const verified = verifyOciLayout({
    layout: path.join(artifactDirectory, "oci-layout"),
    platform: `linux/${architecture}`,
    version,
  })
  const buildMetadata = readJson<BuildxMetadata>(
    path.join(artifactDirectory, "build-metadata.json"),
  )
  verifyBuildxMetadata(
    buildMetadata,
    verified,
    layoutManifestDescriptor(path.join(artifactDirectory, "oci-layout")),
  )
  if (JSON.stringify(recorded) !== JSON.stringify(verified)) {
    throw new Error(`recorded ${architecture} OCI descriptor does not match`)
  }
  return verified
}

export function verifyDockerArtifactSet(options: {
  directory: string
  version: string
}): VerifiedDockerOciDescriptor[] {
  const directory = path.resolve(options.directory)
  return (["amd64", "arm64"] as const).map((architecture) =>
    readAndVerifyArtifact(directory, architecture, options.version),
  )
}

export function verifyPublishedDockerIndex(options: {
  descriptors: VerifiedDockerOciDescriptor[]
  index: string
  publishedDigest: string
  resolvedDigest?: string
}): { digest: string; manifests: number } {
  const resolvedDigest = options.resolvedDigest ?? options.publishedDigest
  if (resolvedDigest !== options.publishedDigest) {
    throw new Error(
      `published Docker index digest ${resolvedDigest} does not match ${options.publishedDigest}`,
    )
  }
  const index = JSON.parse(options.index) as OciIndex
  if (index.schemaVersion !== 2 || !Array.isArray(index.manifests)) {
    throw new Error("published Docker index is malformed")
  }

  const expectedByPlatform = new Map(
    options.descriptors.map((descriptor) => [
      descriptor.platform,
      descriptor.manifestDigest,
    ]),
  )
  const actualByPlatform = new Map<string, string>()
  for (const descriptor of index.manifests) {
    const platform = descriptorPlatform(descriptor)
    if (!platform || !descriptor.digest) {
      throw new Error("published Docker index has an unscoped manifest")
    }
    if (actualByPlatform.has(platform)) {
      throw new Error(`published Docker index duplicates ${platform}`)
    }
    actualByPlatform.set(platform, descriptor.digest)
  }
  if (
    actualByPlatform.size !== expectedByPlatform.size
    || [...expectedByPlatform].some(
      ([platform, digest]) => actualByPlatform.get(platform) !== digest,
    )
  ) {
    throw new Error(
      "published Docker index is not composed from the tested manifests",
    )
  }
  return { digest: resolvedDigest, manifests: actualByPlatform.size }
}

function appendOutputs(
  filePath: string,
  prefix: string,
  descriptor: VerifiedDockerOciDescriptor,
): void {
  fs.appendFileSync(
    filePath,
    [
      `${prefix}config_digest=${descriptor.configDigest}`,
      `${prefix}manifest_digest=${descriptor.manifestDigest}`,
      "",
    ].join("\n"),
  )
}

export function runDockerOciCli(arguments_: string[]): number {
  try {
    const { positionals, values } = parseArgs({
      allowPositionals: true,
      args: arguments_,
      options: {
        directory: { type: "string" },
        "descriptor-output": { type: "string" },
        "github-output": { type: "string" },
        index: { type: "string" },
        layout: { type: "string" },
        metadata: { type: "string" },
        platform: { type: "string" },
        "resolved-digest": { type: "string" },
        version: { type: "string" },
      },
      strict: true,
    })
    const command = positionals[0]
    if (!values.version) throw new Error("--version is required")

    if (command === "verify") {
      if (
        !values.layout
        || !values.metadata
        || !values.platform
        || !values["descriptor-output"]
      ) {
        throw new Error(
          "verify requires --layout, --metadata, --platform, and --descriptor-output",
        )
      }
      const descriptor = verifyOciLayout({
        layout: values.layout,
        platform: values.platform as DockerPlatform,
        version: values.version,
      })
      verifyBuildxMetadata(
        readJson<BuildxMetadata>(values.metadata),
        descriptor,
        layoutManifestDescriptor(values.layout),
      )
      fs.writeFileSync(
        values["descriptor-output"],
        `${JSON.stringify(descriptor, null, 2)}\n`,
      )
      if (values["github-output"]) {
        appendOutputs(values["github-output"], "", descriptor)
      }
      console.log(`dockerManifestDigest=${descriptor.manifestDigest}`)
      console.log(`dockerConfigDigest=${descriptor.configDigest}`)
      return 0
    }

    if (command === "verify-set") {
      if (!values.directory) throw new Error("--directory is required")
      const descriptors = verifyDockerArtifactSet({
        directory: values.directory,
        version: values.version,
      })
      if (values["github-output"]) {
        for (const descriptor of descriptors) {
          appendOutputs(
            values["github-output"],
            `${descriptor.platform.slice("linux/".length)}_`,
            descriptor,
          )
        }
      }
      console.log("dockerArtifactPlatforms=linux/amd64,linux/arm64")
      console.log("dockerArtifactsOk=true")
      return 0
    }

    if (command === "verify-published") {
      if (
        !values.directory
        || !values.index
        || !values.metadata
        || !values["resolved-digest"]
      ) {
        throw new Error(
          "verify-published requires --directory, --index, --metadata, and --resolved-digest",
        )
      }
      const metadata = readJson<BuildxMetadata>(values.metadata)
      const publishedDescriptor = metadata["containerimage.descriptor"]
      const publishedDigest = publishedDescriptor?.digest
      if (
        !publishedDescriptor
        || typeof publishedDigest !== "string"
        || publishedDescriptor.mediaType
          !== "application/vnd.oci.image.index.v1+json"
      ) {
        throw new Error(
          "published metadata has no OCI index containerimage.descriptor",
        )
      }
      const result = verifyPublishedDockerIndex({
        descriptors: verifyDockerArtifactSet({
          directory: values.directory,
          version: values.version,
        }),
        index: fs.readFileSync(values.index, "utf8"),
        publishedDigest,
        resolvedDigest: values["resolved-digest"],
      })
      console.log(`publishedDockerDigest=${result.digest}`)
      console.log("publishedDockerDigestOk=true")
      return 0
    }

    throw new Error("command must be verify, verify-set, or verify-published")
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}

if (import.meta.main) {
  process.exitCode = runDockerOciCli(Bun.argv.slice(2))
}
