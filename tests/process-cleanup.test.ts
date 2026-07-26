import { afterEach, expect, spyOn, test } from "bun:test"

import {
  registerProcessCleanup,
  resetProcessCleanupStateForTests,
  runProcessCleanups,
  runProcessCleanupsSync,
} from "../src/lib/process-cleanup"

afterEach(() => {
  resetProcessCleanupStateForTests()
})

test("a throwing handler does not stop later handlers on the async path", async () => {
  const consoleWarn = spyOn(console, "warn").mockImplementation(() => {})
  const ran: Array<string> = []

  registerProcessCleanup(() => {
    ran.push("first")
  })
  registerProcessCleanup(() => {
    throw new Error("handler exploded")
  })
  registerProcessCleanup(async () => {
    await Promise.resolve()
    throw new Error("async handler exploded")
  })
  registerProcessCleanup(() => {
    ran.push("last")
  })

  await runProcessCleanups()

  expect(ran).toEqual(["first", "last"])
  expect(consoleWarn).toHaveBeenCalledTimes(2)
  consoleWarn.mockRestore()
})

test("runProcessCleanups resolves instead of rejecting when a handler throws", async () => {
  const consoleWarn = spyOn(console, "warn").mockImplementation(() => {})

  registerProcessCleanup(() => {
    throw new Error("handler exploded")
  })

  // A rejection here is what produced the unhandled rejection on `beforeExit`,
  // which invokes this without a `.catch`.
  let caught: unknown
  try {
    await runProcessCleanups()
  } catch (error) {
    caught = error
  }

  expect(caught).toBeUndefined()
  consoleWarn.mockRestore()
})

test("a throwing handler does not stop later handlers on the sync path", () => {
  const consoleWarn = spyOn(console, "warn").mockImplementation(() => {})
  const ran: Array<string> = []

  registerProcessCleanup(() => {
    ran.push("first")
  })
  registerProcessCleanup(() => {
    throw new Error("handler exploded")
  })
  registerProcessCleanup(() => {
    ran.push("last")
  })

  runProcessCleanupsSync()

  expect(ran).toEqual(["first", "last"])
  consoleWarn.mockRestore()
})

test("cleanup ordering follows registration order", async () => {
  const ran: Array<string> = []

  registerProcessCleanup(() => {
    ran.push("a")
  })
  registerProcessCleanup(async () => {
    await Promise.resolve()
    ran.push("b")
  })
  registerProcessCleanup(() => {
    ran.push("c")
  })

  await runProcessCleanups()

  expect(ran).toEqual(["a", "b", "c"])
})

test("cleanups run at most once", async () => {
  let calls = 0
  registerProcessCleanup(() => {
    calls += 1
  })

  await runProcessCleanups()
  await runProcessCleanups()
  runProcessCleanupsSync()

  expect(calls).toBe(1)
})

test("unregistering a handler prevents it from running", async () => {
  const ran: Array<string> = []
  const unregister = registerProcessCleanup(() => {
    ran.push("removed")
  })
  registerProcessCleanup(() => {
    ran.push("kept")
  })

  unregister()
  await runProcessCleanups()

  expect(ran).toEqual(["kept"])
})
