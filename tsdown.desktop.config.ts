import { defineConfig } from "tsdown"

export default defineConfig({
  entry: ["src/main.ts"],

  format: ["esm"],
  target: "es2022",
  platform: "node",
  fixedExtension: false,

  sourcemap: true,
  clean: true,
  removeNodeProtocol: false,
  checks: {
    pluginTimings: false,
  },

  deps: {
    alwaysBundle: [/^(?!sharp(?:$|\/)|@img\/)/u],
    neverBundle: ["sharp", /^@img\//u],
    onlyBundle: false,
  },

  env: {
    NODE_ENV: "production",
  },
})
