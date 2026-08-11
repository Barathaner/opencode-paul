import { test } from "node:test"
import assert from "node:assert"

test("config: profile validation regex", () => {
  const re = /^[a-z0-9][a-z0-9_-]{0,31}$/
  assert.ok(re.test("my-profile"))
  assert.ok(re.test("a"))
  assert.ok(re.test("siteb"))
  assert.ok(!re.test("INVALID"))
  assert.ok(!re.test(""))
  assert.ok(!re.test("-starting-dash"))
})
