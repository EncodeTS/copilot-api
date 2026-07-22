import { describe, expect, test } from "bun:test"

const files = {
  english: await Bun.file(new URL("../README.md", import.meta.url)).text(),
  startBat: await Bun.file(new URL("../start.bat", import.meta.url)).text(),
  zh: await Bun.file(new URL("../README.zh-CN.md", import.meta.url)).text(),
}

describe("network security migration surfaces", () => {
  test.each([files.english, files.zh])(
    "documents the secure Viewer and removed bearer endpoint",
    (readme) => {
      expect(readme).toContain("--lan")
      expect(readme).toContain("127.0.0.1:4141/usage-viewer")
      expect(readme).not.toContain("usage-viewer?endpoint=")
      expect(readme).not.toContain("`GET /token` |")
      expect(readme).not.toContain("localStorage")
    },
  )

  test("Windows launcher opens only the same-origin Viewer URL", () => {
    expect(files.startBat).toContain(
      'start "" "http://127.0.0.1:4141/usage-viewer"',
    )
    expect(files.startBat).not.toContain("endpoint=")
    expect(files.startBat).not.toContain("localhost")
  })
})
