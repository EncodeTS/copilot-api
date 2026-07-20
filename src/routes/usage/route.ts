import { Hono } from "hono"

import { state } from "~/lib/state"
import {
  CopilotUsageFetchError,
  getCopilotUsageSnapshot,
} from "~/services/github/get-copilot-usage"

export const usageRoute = new Hono()

usageRoute.get("/", async (c) => {
  try {
    const snapshot = await getCopilotUsageSnapshot(undefined, {
      expectedLogin: state.userName?.trim() || undefined,
      signal: c.req.raw.signal,
    })
    if (!snapshot) {
      return c.json(null)
    }
    return c.json({
      ...snapshot.usage,
      _copilot_api: snapshot.status,
    })
  } catch (error) {
    if (error instanceof CopilotUsageFetchError) {
      console.error("Error fetching Copilot usage", {
        code: error.code,
        status: error.status,
      })
      const status = getUsageErrorStatus(error)
      if (error.retryAfterMs !== null) {
        c.header("retry-after", String(Math.ceil(error.retryAfterMs / 1_000)))
      }
      return c.json(
        {
          error: {
            code: error.code,
            message: "Failed to fetch Copilot usage",
          },
        },
        status,
      )
    }

    console.error("Error fetching Copilot usage")
    return c.json({ error: "Failed to fetch Copilot usage" }, 500)
  }
})

function getUsageErrorStatus(error: CopilotUsageFetchError) {
  switch (error.code) {
    case "unauthorized":
      return 401 as const
    case "forbidden":
      return 403 as const
    case "rate_limited":
      return 429 as const
    case "aborted":
      return 408 as const
    case "timeout":
      return 504 as const
    default:
      return 502 as const
  }
}
