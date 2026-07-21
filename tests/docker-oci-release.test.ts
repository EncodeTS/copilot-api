import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  type VerifiedDockerOciDescriptor,
  runDockerOciCli,
  verifyDockerArtifactSet,
  verifyOciLayout,
  verifyPublishedDockerIndex,
} from "../scripts/release/docker-oci"

const temporaryDirectories: string[] = []

function sha256(contents: string): string {
  return `sha256:${createHash("sha256").update(contents).digest("hex")}`
}

function writeBlob(
  layout: string,
  contents: string,
): { digest: string; size: number } {
  const digest = sha256(contents)
  const filePath = path.join(layout, "blobs", "sha256", digest.slice(7))
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, contents)
  return { digest, size: Buffer.byteLength(contents) }
}

function writeOciFixture(
  root: string,
  architecture: "amd64" | "arm64",
  version = "2.0.0-rc.14",
): { configDigest: string; manifestDigest: string; version: string } {
  const layout = path.join(root, architecture, "oci-layout")
  fs.mkdirSync(layout, { recursive: true })
  fs.writeFileSync(
    path.join(layout, "oci-layout"),
    `${JSON.stringify({ imageLayoutVersion: "1.0.0" })}\n`,
  )
  const configContents = JSON.stringify({
    architecture,
    config: { Labels: { "org.opencontainers.image.version": version } },
    os: "linux",
  })
  const config = writeBlob(layout, configContents)
  const layer = writeBlob(layout, `layer-${architecture}`)
  const manifestContents = JSON.stringify({
    config: {
      digest: config.digest,
      mediaType: "application/vnd.oci.image.config.v1+json",
      size: config.size,
    },
    layers: [
      {
        digest: layer.digest,
        mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
        size: layer.size,
      },
    ],
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    schemaVersion: 2,
  })
  const manifest = writeBlob(layout, manifestContents)
  const indexContents = JSON.stringify({
    manifests: [
      {
        digest: manifest.digest,
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        platform: { architecture, os: "linux" },
        size: manifest.size,
      },
    ],
    mediaType: "application/vnd.oci.image.index.v1+json",
    schemaVersion: 2,
  })
  fs.writeFileSync(path.join(layout, "index.json"), indexContents)
  const descriptor = {
    configDigest: config.digest,
    manifestDigest: manifest.digest,
    platform: `linux/${architecture}`,
    version,
  }
  fs.writeFileSync(
    path.join(root, architecture, "descriptor.json"),
    `${JSON.stringify(descriptor, null, 2)}\n`,
  )
  fs.writeFileSync(
    path.join(root, architecture, "build-metadata.json"),
    `${JSON.stringify({
      "containerimage.config.digest": config.digest,
      "containerimage.descriptor": {
        annotations: { "config.digest": config.digest },
        digest: manifest.digest,
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        size: manifest.size,
      },
      "containerimage.digest": manifest.digest,
    })}\n`,
  )
  return descriptor
}

function artifactFixture(): string {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "docker-oci-release-"),
  )
  temporaryDirectories.push(directory)
  writeOciFixture(directory, "amd64")
  writeOciFixture(directory, "arm64")
  return directory
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop()!, { force: true, recursive: true })
  }
})

describe("OCI release artifact identity", () => {
  test("verifies the layout manifest descriptor, config, and version", () => {
    const directory = artifactFixture()
    const expected = JSON.parse(
      fs.readFileSync(path.join(directory, "amd64", "descriptor.json"), "utf8"),
    ) as VerifiedDockerOciDescriptor

    expect(
      verifyOciLayout({
        layout: path.join(directory, "amd64", "oci-layout"),
        platform: "linux/amd64",
        version: "2.0.0-rc.14",
      }),
    ).toEqual(expected)

    const indexContents = fs.readFileSync(
      path.join(directory, "amd64", "oci-layout", "index.json"),
      "utf8",
    )
    expect(expected.manifestDigest).not.toBe(sha256(indexContents))
  })

  test("verifies exactly one amd64 and arm64 artifact as a set", () => {
    const directory = artifactFixture()
    const result = verifyDockerArtifactSet({
      directory,
      version: "2.0.0-rc.14",
    })

    expect(result.map((item) => item.platform)).toEqual([
      "linux/amd64",
      "linux/arm64",
    ])
  })

  test("fails closed when an OCI blob or recorded descriptor is altered", () => {
    const directory = artifactFixture()
    const descriptorPath = path.join(directory, "amd64", "descriptor.json")
    const descriptor = JSON.parse(fs.readFileSync(descriptorPath, "utf8")) as {
      configDigest: string
    }
    fs.appendFileSync(
      path.join(
        directory,
        "amd64",
        "oci-layout",
        "blobs",
        "sha256",
        descriptor.configDigest.slice(7),
      ),
      "tampered",
    )

    expect(() =>
      verifyDockerArtifactSet({
        directory,
        version: "2.0.0-rc.14",
      }),
    ).toThrow("digest mismatch")
  })

  test("verifies the published index is composed only from tested manifests", () => {
    const directory = artifactFixture()
    const descriptors = verifyDockerArtifactSet({
      directory,
      version: "2.0.0-rc.14",
    })
    const index = JSON.stringify({
      manifests: descriptors.map((descriptor) => ({
        digest: descriptor.manifestDigest,
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        platform: {
          architecture: descriptor.platform.slice("linux/".length),
          os: "linux",
        },
        size: 1,
      })),
      mediaType: "application/vnd.oci.image.index.v1+json",
      schemaVersion: 2,
    })
    const digest = sha256(index)

    expect(
      verifyPublishedDockerIndex({
        descriptors,
        index,
        publishedDigest: digest,
      }),
    ).toEqual({ digest, manifests: 2 })

    expect(() =>
      verifyPublishedDockerIndex({
        descriptors,
        index,
        publishedDigest: digest,
        resolvedDigest: `sha256:${"0".repeat(64)}`,
      }),
    ).toThrow("published Docker index digest")
  })

  test("exposes verify, set, and published checks through the public CLI", () => {
    const directory = artifactFixture()
    const cliDirectory = temporaryDirectories[0]
    const descriptorOutput = path.join(cliDirectory, "verified.json")
    const githubOutput = path.join(cliDirectory, "github-output")
    expect(
      runDockerOciCli([
        "verify",
        "--layout",
        path.join(directory, "amd64", "oci-layout"),
        "--metadata",
        path.join(directory, "amd64", "build-metadata.json"),
        "--platform",
        "linux/amd64",
        "--version",
        "2.0.0-rc.14",
        "--descriptor-output",
        descriptorOutput,
        "--github-output",
        githubOutput,
      ]),
    ).toBe(0)
    expect(fs.readFileSync(githubOutput, "utf8")).toContain("manifest_digest=")

    expect(
      runDockerOciCli([
        "verify-set",
        "--directory",
        directory,
        "--version",
        "2.0.0-rc.14",
        "--github-output",
        githubOutput,
      ]),
    ).toBe(0)

    const descriptors = verifyDockerArtifactSet({
      directory,
      version: "2.0.0-rc.14",
    })
    const index = JSON.stringify({
      manifests: descriptors.map((descriptor) => ({
        digest: descriptor.manifestDigest,
        platform: {
          architecture: descriptor.platform.slice("linux/".length),
          os: "linux",
        },
      })),
      schemaVersion: 2,
    })
    const indexPath = path.join(cliDirectory, "published-index.json")
    const metadataPath = path.join(cliDirectory, "published-metadata.json")
    fs.writeFileSync(indexPath, index)
    fs.writeFileSync(
      metadataPath,
      JSON.stringify({
        "containerimage.descriptor": {
          digest: sha256(index),
          mediaType: "application/vnd.oci.image.index.v1+json",
          size: Buffer.byteLength(index),
        },
        "image.name": "ghcr.io/encodets/copilot-api",
      }),
    )
    expect(
      runDockerOciCli([
        "verify-published",
        "--directory",
        directory,
        "--version",
        "2.0.0-rc.14",
        "--index",
        indexPath,
        "--metadata",
        metadataPath,
        "--resolved-digest",
        sha256(index),
      ]),
    ).toBe(0)
    expect(runDockerOciCli(["unknown", "--version", "2.0.0-rc.14"])).toBe(1)
  })
})
