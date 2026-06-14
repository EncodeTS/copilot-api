import consola from "consola"
import tls from "node:tls"

export function enableSystemCACompat() {
  const isBun = typeof Bun !== "undefined"
  if (!isBun) {
    try {
      const defaultCerts = tls.getCACertificates("default")
      const systemCerts = tls.getCACertificates("system")
      tls.setDefaultCACertificates([...defaultCerts, ...systemCerts])

      consola.log("[tls] system ca enabled")
    } catch (e) {
      consola.warn("[tls] system ca not available:", e)
    }
  }
}
