import { describe, expect, test } from "bun:test"
import {
  ProviderBaseUrlPolicyError,
  validateProviderBaseUrl,
} from "~/lib/provider-url-policy"

describe("provider base URL policy", () => {
  test("accepts HTTPS provider URLs and removes trailing slashes", () => {
    expect(validateProviderBaseUrl(" https://api.example.com/v1/// ")).toBe(
      "https://api.example.com/v1",
    )
  })

  test("accepts HTTP only for loopback providers by default", () => {
    expect(validateProviderBaseUrl("http://localhost:8080/v1/")).toBe(
      "http://localhost:8080/v1",
    )
    expect(validateProviderBaseUrl("http://127.42.1.9:8080/v1")).toBe(
      "http://127.42.1.9:8080/v1",
    )
    expect(validateProviderBaseUrl("http://[::1]:8080/v1")).toBe(
      "http://[::1]:8080/v1",
    )
  })

  test("rejects insecure non-loopback and non-HTTP provider URLs", () => {
    expect(() => validateProviderBaseUrl(" ")).toThrow(
      ProviderBaseUrlPolicyError,
    )
    expect(() => validateProviderBaseUrl("://invalid")).toThrow(
      ProviderBaseUrlPolicyError,
    )
    expect(() => validateProviderBaseUrl("http://api.example.com/v1")).toThrow(
      ProviderBaseUrlPolicyError,
    )
    expect(() => validateProviderBaseUrl("ftp://api.example.com/v1")).toThrow(
      ProviderBaseUrlPolicyError,
    )
  })

  test("allows non-loopback HTTP only with an explicit insecure opt-in", () => {
    expect(
      validateProviderBaseUrl("http://api.example.com/v1/", {
        allowInsecureHttp: true,
      }),
    ).toBe("http://api.example.com/v1")
  })
})
