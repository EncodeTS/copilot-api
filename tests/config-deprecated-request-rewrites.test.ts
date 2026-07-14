import { expect, test } from "bun:test"

import type { AppConfig } from "../src/lib/config"
import { mergeDefaultConfig } from "../src/lib/config"

type DeprecatedRequestRewriteConfig = {
  parityFirst?: boolean
  smallModel?: string
}

const deprecatedConfigs: Array<{
  config: DeprecatedRequestRewriteConfig
  key: keyof DeprecatedRequestRewriteConfig
}> = [
  {
    config: { parityFirst: false },
    key: "parityFirst",
  },
  {
    config: { smallModel: "gpt-5-mini" },
    key: "smallModel",
  },
]

for (const { config, key } of deprecatedConfigs) {
  test(`removes deprecated ${key} config independently`, () => {
    const { changed, mergedConfig } = mergeDefaultConfig(config as AppConfig)

    expect(changed).toBe(true)
    expect(Object.hasOwn(mergedConfig, key)).toBe(false)
  })
}
