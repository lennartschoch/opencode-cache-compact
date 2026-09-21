import { test } from "node:test"
import assert from "node:assert/strict"

import { cutMessages, extractText, SUMMARY_HEADING, type AnyMessage } from "../src/cut.ts"

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
