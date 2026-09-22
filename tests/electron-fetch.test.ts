import { describe, expect, test } from "bun:test"

import {
  createBoundElectronFetch,
  requestCarriesAuthorization,
} from "../src/lib/electron-fetch"

describe("electron fetch binding", () => {
  test("detects authorization headers regardless of casing or container", () => {
    expect(
      requestCarriesAuthorization("https://api.github.com/user", {
        headers: { authorization: "token secret" },
      }),
    ).toBe(true)
    expect(
      requestCarriesAuthorization("https://api.github.com/user", {
        headers: new Headers({ Authorization: "Bearer secret" }),
      }),
    ).toBe(true)
    expect(
      requestCarriesAuthorization("https://api.github.com/user", {
        headers: [["Authorization", "token secret"]],
      }),
    ).toBe(true)
    expect(
      requestCarriesAuthorization(
        new Request("https://api.github.com/user", {
          headers: { authorization: "token secret" },
        }),
      ),
    ).toBe(true)
    expect(
      requestCarriesAuthorization("https://github.com/login/device/code", {
        headers: { accept: "application/json" },
      }),
    ).toBe(false)
  })

  test("keeps credentialed requests on Node fetch", async () => {
    const calls: Array<string> = []
    const nodeFetch = (() => {
      calls.push("node")
      return Promise.resolve(new Response("node"))
    }) as typeof fetch
    const netFetch = (() => {
      calls.push("net")
      return Promise.resolve(new Response("net"))
    }) as typeof fetch
    const fetch = createBoundElectronFetch(nodeFetch, netFetch)

    await fetch("https://api.github.com/user", {
      headers: { authorization: "token secret" },
    })
    await fetch("https://github.com/login/device/code")

    expect(calls).toEqual(["node", "net"])
  })
})
