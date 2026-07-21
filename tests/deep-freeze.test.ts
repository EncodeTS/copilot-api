import { expect, test } from "bun:test"

import { deepFreeze } from "~/lib/deep-freeze"

test("deepFreeze freezes nested cyclic object graphs once", () => {
  const value: {
    child: { items: Array<number> }
    self?: unknown
  } = {
    child: { items: [1, 2, 3] },
  }
  value.self = value

  expect(deepFreeze(value)).toBe(value)
  expect(Object.isFrozen(value)).toBe(true)
  expect(Object.isFrozen(value.child)).toBe(true)
  expect(Object.isFrozen(value.child.items)).toBe(true)
  expect(Reflect.set(value.child, "items", [])).toBe(false)
})

test("deepFreeze handles a deeply nested graph without recursive overflow", () => {
  const root: Record<string, unknown> = {}
  let current = root
  for (let index = 0; index < 20_000; index += 1) {
    const child: Record<string, unknown> = {}
    current.child = child
    current = child
  }

  expect(deepFreeze(root)).toBe(root)
  expect(Object.isFrozen(root)).toBe(true)
  expect(Object.isFrozen(current)).toBe(true)
})
