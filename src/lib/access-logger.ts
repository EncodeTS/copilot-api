export type AccessLogOutput = (message: string) => void

const defaultAccessLogOutput: AccessLogOutput = (message) => {
  console.log(message)
}

export const stripAccessLogQuery = (message: string): string => {
  const methodEnd = message.indexOf(" ", message.indexOf(" ") + 1)
  if (methodEnd < 0) return message

  const pathStart = methodEnd + 1
  const pathEnd = message.indexOf(" ", pathStart)
  const queryStart = message.indexOf("?", pathStart)
  if (queryStart < 0 || (pathEnd >= 0 && queryStart > pathEnd)) return message

  return (
    message.slice(0, queryStart) + (pathEnd < 0 ? "" : message.slice(pathEnd))
  )
}

export const createQuerySafeAccessLogOutput =
  (output: AccessLogOutput = defaultAccessLogOutput): AccessLogOutput =>
  (message) =>
    output(stripAccessLogQuery(message))
