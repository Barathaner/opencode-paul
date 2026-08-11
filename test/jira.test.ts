import { test } from "node:test"
import assert from "node:assert"
import { buildJQL, subfilterEncode, subfilterAt } from "../src/jira.ts"

test("jira: buildJQL unscoped", () => {
  const jql = buildJQL("KAN")
  assert.strictEqual(jql, 'project = "KAN" ORDER BY created DESC')
})

test("jira: buildJQL with filters and sub-filters", () => {
  const jql = buildJQL("KAN", "10000,10001", [
    Buffer.from("status != Done OR updated >= -14d").toString("base64"),
    "",
  ].join(","))
  assert.ok(jql.includes('filter = 10000'))
  assert.ok(jql.includes('status != Done'))
  assert.ok(jql.includes('filter = 10001'))
})

test("jira: buildJQL --full-filter drops sub-filters", () => {
  const jql = buildJQL("KAN", "10000", Buffer.from("status != Done").toString("base64"), true)
  assert.ok(!jql.includes("status"))
  assert.ok(jql.includes('filter = 10000'))
})

test("jira: subfilter encode/decode round-trip", () => {
  const original = "status != Done OR updated >= -14d"
  const encoded = subfilterEncode(original)
  assert.ok(encoded.length > 0)
  const decoded = subfilterAt(encoded, 1)
  assert.strictEqual(decoded, original)
})

test("jira: subfilterAt empty", () => {
  assert.strictEqual(subfilterAt("", 1), "")
  assert.strictEqual(subfilterAt("a,b,c", 5), "")
})

test("jira: buildJQL empty filters", () => {
  const jql = buildJQL("KAN", "", "anything")
  assert.strictEqual(jql, 'project = "KAN" ORDER BY created DESC')
})

test("jira: buildJQL single filter no sub", () => {
  const jql = buildJQL("KAN", "12345")
  assert.ok(jql.includes("filter = 12345"))
})
