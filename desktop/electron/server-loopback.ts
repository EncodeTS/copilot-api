export const SERVER_LOOPBACK_HOST = '127.0.0.1'

export function buildServerLoopbackUrl(port: number, path = '/'): string {
  return new URL(path, `http://${SERVER_LOOPBACK_HOST}:${port}`).toString()
}
