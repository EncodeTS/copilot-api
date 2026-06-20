import { defineConfig } from "tsdown"

export default defineConfig({
  entry: ["src/main.ts"],

  format: ["esm"],
  target: "es2022",
  platform: "node",

  sourcemap: true,
  clean: true,
  removeNodeProtocol: false,

  external: ["sharp", /^@img\//u],
  noExternal: (id: string) => id !== "sharp" && !id.startsWith("@img/"),

  env: {
    NODE_ENV: "production",
  },
})
