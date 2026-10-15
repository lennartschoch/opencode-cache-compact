import { test } from "node:test"
import assert from "node:assert/strict"

import { cutMessages, cutV2Messages, extractText, findSummaryKeys, SUMMARY_HEADING, type AnyMessage, type AnyMessageV2 } from "../src/cut.ts"

const text = (id: string, body: string): AnyMessage => ({
  info: { id, role: "user", sessionID: "ses_1" },
  parts: [{ type: "text", text: body, id: `${id}-p`, messageID: id, sessionID: "ses_1" }],
})

const assistant = (id: string, body: string): AnyMessage => ({
  info: { id, role: "assistant", sessionID: "ses_1" },
  parts: [{ type: "text", text: body, id: `${id}-p`, messageID: id, sessionID: "ses_1" }],
})

test("extractText joins visible text and skips ignored parts", () => {
  assert.equal(
    extractText([
      { type: "text", text: "a" },
      { type: "reasoning", text: "ignored" },
      { type: "text", text: "b", ignored: true },
      { type: "text", text: "c" },
    ]),
    "a\nc",
  )
})

test("cuts everything before the boundary and keeps the tail", () => {
  const messages: AnyMessage[] = [
    text("u1", "original task"),
    assistant("a1", "working on it"),
    text("u2", "here is more"),
    assistant("a2", "done"),
    text("sum_req", "please summarize"),
    assistant("sum", "SUMMARY TEXT"),
    text("u3", "next task"),
    assistant("a3", "on it"),
  ]

  const removed = cutMessages(messages, "sum_req", "sum")

  assert.equal(removed, 5)
  assert.deepEqual(
    messages.map((m) => m.info.id),
    ["sum_req", "u3", "a3"],
  )
  assert.equal(messages[0]!.parts.length, 1)
  assert.equal(messages[0]!.parts[0]!.text, `${SUMMARY_HEADING}\n\nSUMMARY TEXT`)
  // id + role of the boundary message are preserved so the provider sees a real user turn
  assert.equal(messages[0]!.info.id, "sum_req")
  assert.equal(messages[0]!.info.role, "user")
  assert.equal(messages[0]!.parts[0]!.id, "sum_req-p")
})

test("second cut composes on top of a previous cut", () => {
  const messages: AnyMessage[] = [
    text("sum_req1", `${SUMMARY_HEADING}\n\nFIRST SUMMARY`),
    text("u3", "next task"),
    assistant("a3", "on it"),
    text("sum_req2", "please summarize again"),
    assistant("sum2", "SECOND SUMMARY"),
    text("u4", "continue"),
  ]

  const removed = cutMessages(messages, "sum_req2", "sum2")

  assert.equal(removed, 4)
  assert.deepEqual(
    messages.map((m) => m.info.id),
    ["sum_req2", "u4"],
  )
  assert.equal(messages[0]!.parts[0]!.text, `${SUMMARY_HEADING}\n\nSECOND SUMMARY`)
})

test("does not cut when the summary has no text", () => {
  const messages: AnyMessage[] = [
    text("u1", "task"),
    text("sum_req", "summarize"),
    assistant("sum", ""),
    text("u2", "next"),
  ]

  assert.equal(cutMessages(messages, "sum_req", "sum"), 0)
  assert.equal(messages.length, 4)
})

test("does not cut when the boundary or summary is absent", () => {
  const messages: AnyMessage[] = [text("u1", "task"), assistant("a1", "ok")]
  assert.equal(cutMessages(messages, "missing", "a1"), 0)
  assert.equal(cutMessages(messages, "u1", "missing"), 0)
  assert.equal(messages.length, 2)
})

const v2 = (role: string, body: string): AnyMessageV2 => ({
  role,
  content: [{ type: "text", text: body }],
})

test("v2 cut locates the boundary by prompt text and rewrites it", () => {
  const messages: AnyMessageV2[] = [
    v2("user", "original task"),
    v2("assistant", "working"),
    v2("user", "PLEASE SUMMARIZE"),
    v2("assistant", "SUMMARY TEXT"),
    v2("user", "continue"),
  ]

  const removed = cutV2Messages(messages, "PLEASE SUMMARIZE", "SUMMARY TEXT")

  assert.equal(removed, 3)
  assert.equal(messages.length, 2)
  assert.equal(messages[0]!.content![0]!.text, `${SUMMARY_HEADING}\n\nSUMMARY TEXT`)
  assert.equal(messages[1]!.content![0]!.text, "continue")
})

test("v2 cut does nothing when the pieces are missing", () => {
  const messages: AnyMessageV2[] = [v2("user", "task"), v2("assistant", "ok")]
  assert.equal(cutV2Messages(messages, "no such prompt", "SUMMARY"), 0)
  assert.equal(cutV2Messages(messages, "task", "no such summary"), 0)
  assert.equal(messages.length, 2)
})

const reply = (id: string, parentID: string, body: string, extra: Record<string, unknown> = {}): AnyMessage => ({
  info: { id, role: "assistant", sessionID: "ses_1", parentID, ...extra },
  parts: [{ type: "text", text: body, id: `${id}-p`, messageID: id, sessionID: "ses_1" }],
})

test("findSummaryKeys rebuilds the cut keys from the latest summary exchange", () => {
  const messages: AnyMessage[] = [
    text("u1", "task"),
    text("req1", "SUMMARIZE"),
    reply("sum1", "req1", "FIRST"),
    text("u2", "more"),
    text("req2", "SUMMARIZE"),
    reply("sum2", "req2", "SECOND"),
    text("u3", "next"),
  ]
  assert.deepEqual(findSummaryKeys(messages, "SUMMARIZE"), {
    boundaryUserID: "req2",
    summaryAssistantID: "sum2",
    text: "SECOND",
  })
})

test("findSummaryKeys ignores empty and errored replies and falls back to an earlier summary", () => {
  const messages: AnyMessage[] = [
    text("req1", "SUMMARIZE"),
    reply("sum1", "req1", "FIRST"),
    text("req2", "SUMMARIZE"),
    reply("sum2", "req2", "", {}),
    text("req3", "SUMMARIZE"),
    reply("sum3", "req3", "PARTIAL", { error: { name: "Aborted" } }),
  ]
  assert.equal(findSummaryKeys(messages, "SUMMARIZE")?.summaryAssistantID, "sum1")
})

test("findSummaryKeys returns undefined without a matching summary exchange", () => {
  assert.equal(findSummaryKeys([text("u1", "task"), reply("a1", "u1", "ok")], "SUMMARIZE"), undefined)
  assert.equal(findSummaryKeys([text("req1", "other prompt"), reply("sum1", "req1", "X")], "SUMMARIZE"), undefined)
  assert.equal(findSummaryKeys([], "SUMMARIZE"), undefined)
})
