import { defineConfig } from "tsdown"

export default defineConfig({
  entry: ["src/main.ts", "src/tokenizer-worker.ts", "src/zstd-worker.ts"],

  format: ["esm"],
  target: "es2022",
  platform: "node",
  fixedExtension: false,

  sourcemap: true,
  clean: true,
  removeNodeProtocol: false,

  env: {
    NODE_ENV: "production",
  },
})
