const accessLines: Array<string> = []
console.log = (...values: Array<unknown>) => {
  const line = values.map(String).join(" ")
  if (line.startsWith("<-- ") || line.startsWith("--> ")) {
    accessLines.push(line)
  }
}

const { server } = await import("../../src/server")

const alphaResponse = await server.request(
  "http://127.0.0.1/missing/v1/alpha/search?q=private-query&token=private-token",
  { body: "{}", method: "POST" },
)
await alphaResponse.arrayBuffer()

const ordinaryResponse = await server.request(
  "http://127.0.0.1/?probe=private-probe",
)
await ordinaryResponse.arrayBuffer()

process.stdout.write(
  JSON.stringify({
    accessLines,
    statuses: [alphaResponse.status, ordinaryResponse.status],
  }),
)
